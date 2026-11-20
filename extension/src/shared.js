(function (globalScope) {
  const DEFAULT_FLYWHEEL_URL = 'https://anti-slop-flywheel.kuhung.workers.dev';
  const DEFAULT_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/decisions';
  const DEFAULT_AI_MODEL = 'gemini-decision-1';

  const DEFAULT_SETTINGS = {
    enabled: true,
    displayMode: 'hide', // 'hide' | 'mask'
    badgeMode: 'corner', // 'corner' | 'count' | 'none'
    flywheelEnabled: true,
    flywheelUrl: '',
    flywheelToken: '',
    syncIntervalMinutes: 5,
    aiEnabled: false,
    aiApiKey: '',
    aiBaseUrl: DEFAULT_AI_BASE_URL,
    aiModel: DEFAULT_AI_MODEL,
    aiScanScope: 'replies', // 'replies' | 'all'
  };

  function normalizeDisplayMode(mode) {
    return mode === 'mask' ? 'mask' : 'hide';
  }

  function normalizeBadgeMode(mode) {
    if (mode === 'count' || mode === 'none') return mode;
    return 'corner';
  }

  function normalizeAiScanScope(scope) {
    return scope === 'all' ? 'all' : 'replies';
  }

  function normalizeBaseUrl(rawUrl) {
    return typeof rawUrl === 'string' ? rawUrl.trim().replace(/\/+$/, '') : '';
  }

  function normalizeSettings(raw = {}) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const flywheelUrl = normalizeBaseUrl(src.flywheelUrl || '');
    const flywheelToken = typeof src.flywheelToken === 'string' ? src.flywheelToken.trim() : '';

    const syncMins = Number(src.syncIntervalMinutes);
    return {
      enabled: src.enabled !== false,
      displayMode: normalizeDisplayMode(src.displayMode),
      badgeMode: normalizeBadgeMode(src.badgeMode),
      flywheelEnabled: src.flywheelEnabled !== false,
      flywheelUrl,
      flywheelToken,
      syncIntervalMinutes: Number.isFinite(syncMins) && syncMins >= 1 ? Math.min(1440, Math.round(syncMins)) : 5,
      aiEnabled: Boolean(src.aiEnabled),
      aiApiKey: typeof src.aiApiKey === 'string' ? src.aiApiKey.trim() : '',
      aiBaseUrl: normalizeBaseUrl(src.aiBaseUrl) || DEFAULT_AI_BASE_URL,
      aiModel: typeof src.aiModel === 'string' && src.aiModel.trim() ? src.aiModel.trim() : DEFAULT_AI_MODEL,
      aiScanScope: normalizeAiScanScope(src.aiScanScope),
    };
  }

  function resolveFlywheelUrl(settings, defaultUrl = DEFAULT_FLYWHEEL_URL) {
    const norm = normalizeSettings(settings);
    if (!norm.flywheelEnabled) return '';
    return normalizeBaseUrl(norm.flywheelUrl || defaultUrl || '');
  }

  const RESERVED_PATHS = new Set([
    'home',
    'explore',
    'notifications',
    'messages',
    'i',
    'search',
    'settings',
    'compose',
  ]);

  function normalizeHandle(handle) {
    if (!handle || typeof handle !== 'string') return '';
    return handle.trim().replace(/^@+/, '').toLowerCase();
  }

  function hashString(str) {
    let hash = 0x811c9dc5;
    const input = String(str || '');
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function isInsideContainer(container, node) {
    if (!container || !node) return false;
    if (container === node) return true;
    if (typeof container.contains === 'function') {
      return container.contains(node);
    }
    let cur = node.parentElement || null;
    while (cur) {
      if (cur === container) return true;
      cur = cur.parentElement || null;
    }
    return false;
  }

  function findQuoteCardRoot(articleEl, primaryUserNameEl, quotedUserNameEl) {
    if (!quotedUserNameEl) return null;
    let quoteRoot = quotedUserNameEl;
    let cur = quotedUserNameEl.parentElement || null;
    while (cur && cur !== articleEl) {
      if (primaryUserNameEl && isInsideContainer(cur, primaryUserNameEl)) {
        break;
      }
      quoteRoot = cur;
      cur = cur.parentElement || null;
    }
    return quoteRoot;
  }

  function extractUserFromNameBox(userNameEl) {
    let handle = '';
    let displayName = '';
    let hasVerifiedBadge = false;

    if (!userNameEl || typeof userNameEl.querySelectorAll !== 'function') {
      return { handle, displayName, hasVerifiedBadge };
    }

    if (typeof userNameEl.querySelector === 'function') {
      hasVerifiedBadge = Boolean(userNameEl.querySelector('[data-testid="icon-verified"]'));
    }

    const userLinks = userNameEl.querySelectorAll('a[href^="/"]');
    for (const link of userLinks) {
      const href = (link.getAttribute && link.getAttribute('href')) || '';
      const hMatch = href.match(/^\/([A-Za-z0-9_]{1,30})$/);
      if (hMatch && !RESERVED_PATHS.has(hMatch[1].toLowerCase())) {
        if (!handle) handle = normalizeHandle(hMatch[1]);
        break;
      }
    }

    const spans = userNameEl.querySelectorAll('span');
    for (const sp of spans) {
      const txt = (sp.textContent || '').trim();
      if (!txt) continue;
      if (txt.startsWith('@')) {
        if (!handle) handle = normalizeHandle(txt);
      } else if (!displayName && txt !== '·') {
        displayName = txt;
      }
    }

    return { handle, displayName, hasVerifiedBadge };
  }

  function extractTweetData(articleEl, context = {}) {
    if (!articleEl || typeof articleEl.querySelector !== 'function') return null;

    const userNameEls = Array.from(articleEl.querySelectorAll('[data-testid="User-Name"]') || []);
    const primaryUserNameEl = userNameEls[0] || null;
    const quotedUserNameEl = userNameEls.length > 1 ? userNameEls[1] : null;
    const quoteRoot = findQuoteCardRoot(articleEl, primaryUserNameEl, quotedUserNameEl);

    const primaryUser = extractUserFromNameBox(primaryUserNameEl);
    const quotedUser = extractUserFromNameBox(quotedUserNameEl);

    let handle = primaryUser.handle;
    const displayName = primaryUser.displayName;
    let quotedHandle = quotedUser.handle;
    let tweetId = null;
    let fallbackOuterTweetId = null;
    let timeLinkHandle = '';
    let fallbackLinkHandle = '';

    const statusLinks = articleEl.querySelectorAll('a[href*="/status/"]') || [];
    for (const link of statusLinks) {
      const href = (link.getAttribute && link.getAttribute('href')) || '';
      const iStatusMatch = href.match(/^(?:https?:\/\/(?:x|twitter)\.com)?\/i\/(?:web\/)?status\/(\d+)/i);
      const userStatusMatch = iStatusMatch
        ? null
        : href.match(/^(?:https?:\/\/(?:x|twitter)\.com)?\/([A-Za-z0-9_]{1,30})\/status\/(\d+)/i);
      if (!iStatusMatch && !userStatusMatch) continue;

      const linkTweetId = iStatusMatch ? iStatusMatch[1] : userStatusMatch[2];
      const rawLinkHandle = userStatusMatch ? userStatusMatch[1] : '';
      const normLinkHandle =
        rawLinkHandle && !RESERVED_PATHS.has(rawLinkHandle.toLowerCase()) ? normalizeHandle(rawLinkHandle) : '';

      if (quoteRoot && isInsideContainer(quoteRoot, link)) {
        if (!quotedHandle && normLinkHandle) quotedHandle = normLinkHandle;
      } else {
        const hasTime = typeof link.querySelector === 'function' && Boolean(link.querySelector('time'));
        if (hasTime) {
          if (!tweetId) tweetId = linkTweetId;
          if (!timeLinkHandle && normLinkHandle) timeLinkHandle = normLinkHandle;
        } else {
          if (!fallbackOuterTweetId) fallbackOuterTweetId = linkTweetId;
          if (!fallbackLinkHandle && normLinkHandle) fallbackLinkHandle = normLinkHandle;
        }
      }
    }

    if (!handle) handle = timeLinkHandle || fallbackLinkHandle;
    if (!tweetId) tweetId = fallbackOuterTweetId;

    let text = '';
    let quotedText = '';
    let textEls = Array.from(articleEl.querySelectorAll('[data-testid="tweetText"]') || []);
    if (textEls.length === 0) {
      textEls = Array.from(articleEl.querySelectorAll('div[lang]') || []);
    }
    for (const el of textEls) {
      const content = (el.textContent || '').trim();
      if (quoteRoot && isInsideContainer(quoteRoot, el)) {
        if (!quotedText) quotedText = content;
      } else if (!text) {
        text = content;
      }
    }

    let publishedAt = null;
    const timeEls = articleEl.querySelectorAll('time[datetime]') || [];
    for (const tEl of timeEls) {
      if (quoteRoot && isInsideContainer(quoteRoot, tEl)) continue;
      const dt = tEl.getAttribute && tEl.getAttribute('datetime');
      if (dt) {
        publishedAt = dt;
        break;
      }
    }

    let isRetweet = false;
    let retweeterHandle = '';
    const socialCtx = articleEl.querySelector('[data-testid="socialContext"]');
    if (socialCtx) {
      const ctxRaw = socialCtx.textContent || '';
      const ctxText = ctxRaw.toLowerCase();
      if (
        ctxText.includes('reposted') ||
        ctxText.includes('retweeted') ||
        ctxRaw.includes('转帖') ||
        ctxRaw.includes('转推') ||
        ctxRaw.includes('轉發') ||
        ctxRaw.includes('轉貼') ||
        ctxRaw.includes('リポスト')
      ) {
        isRetweet = true;
        const rtLink =
          (typeof socialCtx.closest === 'function' && socialCtx.closest('a[href^="/"]')) ||
          (typeof socialCtx.querySelector === 'function' && socialCtx.querySelector('a[href^="/"]'));
        if (rtLink && rtLink.getAttribute) {
          const m = (rtLink.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,30})/);
          if (m && !RESERVED_PATHS.has(m[1].toLowerCase())) {
            retweeterHandle = normalizeHandle(m[1]);
          }
        }
      }
    }

    let isReply = false;
    if (context && context.focalTweetId) {
      if (tweetId && String(tweetId) === String(context.focalTweetId)) {
        isReply = false;
      } else if (context.afterFocal !== false) {
        isReply = true;
      }
    }
    if (!isReply) {
      const actionGroupEl = articleEl.querySelector('[role="group"]');
      const replyBannerNodes = Array.from(articleEl.querySelectorAll('div[dir="ltr"], [data-testid="reply-banner"]') || []);
      for (const node of replyBannerNodes) {
        if (quoteRoot && isInsideContainer(quoteRoot, node)) continue;
        if (actionGroupEl && isInsideContainer(actionGroupEl, node)) continue;
        if (textEls.some((tEl) => isInsideContainer(tEl, node))) continue;
        if (/(?:^|\n)\s*(?:Replying to|回复)\s*@/i.test((node.textContent || '').trim())) {
          isReply = true;
          break;
        }
      }
      if (!isReply && replyBannerNodes.length === 0) {
        const rawText = String(articleEl.textContent || '');
        const textHasPrefix = textEls.some((tEl) => /(?:^|\n)\s*(?:Replying to|回复)\s*@/i.test(tEl.textContent || ''));
        if (rawText && !textHasPrefix && /(?:^|\n)\s*(?:Replying to|回复)\s*@/i.test(rawText)) {
          isReply = true;
        }
      }
    }

    if (!handle && !text && !quotedHandle) return null;

    let finalTweetId = tweetId;
    if (!finalTweetId) {
      let mediaHint = '';
      let fallbackMediaHint = '';
      const mediaEls = Array.from(articleEl.querySelectorAll('img[src], video[poster]') || []);
      for (const mEl of mediaEls) {
        if (quoteRoot && isInsideContainer(quoteRoot, mEl)) continue;
        const src = mEl.getAttribute && (mEl.getAttribute('src') || mEl.getAttribute('poster'));
        if (!src) continue;
        const isAvatar =
          (typeof mEl.closest === 'function' && Boolean(mEl.closest('[data-testid="Tweet-User-Avatar"]'))) ||
          src.includes('/profile_images/') ||
          src.includes('/emoji/');
        if (!isAvatar) {
          mediaHint = src;
          break;
        }
        if (!fallbackMediaHint) fallbackMediaHint = src;
      }
      if (!mediaHint) mediaHint = fallbackMediaHint;

      const hasSeed = Boolean(text || quotedText || publishedAt || mediaHint);
      const idOwner = handle || quotedHandle || 'anon';
      finalTweetId = hasSeed
        ? `dom_${idOwner}_${hashString([handle, quotedHandle, publishedAt || '', text, quotedText, mediaHint].join('|'))}`
        : `dom_${idOwner}`;
    }

    if (context && context.focalTweetId && String(finalTweetId) === String(context.focalTweetId)) {
      isReply = false;
    }

    return {
      tweetId: finalTweetId,
      handle,
      retweeterHandle,
      quotedHandle,
      displayName,
      text,
      quotedText,
      isRetweet,
      isReply,
      isVerified: Boolean(primaryUser.hasVerifiedBadge),
      publishedAt,
    };
  }

  function makeDecision(item, { verdict, scope, matchedHandle, source, reason }) {
    return {
      tweetId: item?.tweetId ?? null,
      handle: normalizeHandle(item?.handle || ''),
      matchedHandle: normalizeHandle(matchedHandle || item?.handle || ''),
      verdict,
      scope,
      source,
      reason,
    };
  }

  /**
   * Pure O(1) local allow/block list evaluation (content classification runs on Gemini Decisions).
   */
  function evaluateLocalRules(item, lists = {}, options = {}) {
    const handle = normalizeHandle(item?.handle || '');
    const rtHandle = normalizeHandle(item?.retweeterHandle || '');
    const quotedHandle = normalizeHandle(item?.quotedHandle || '');
    const selfHandle = normalizeHandle(options.selfHandle || item?.selfHandle || '');

    const whitelistSet = lists.whitelistSet instanceof Set ? lists.whitelistSet : new Set();
    const blacklistSet = lists.blacklistSet instanceof Set ? lists.blacklistSet : new Set();
    const sessionAccountsSet = lists.sessionAccountsSet instanceof Set ? lists.sessionAccountsSet : new Set();
    const blockedTweetsSet = lists.blockedTweetsSet instanceof Set ? lists.blockedTweetsSet : new Set();
    const allowedTweetsSet = lists.allowedTweetsSet instanceof Set ? lists.allowedTweetsSet : new Set();

    if (selfHandle && handle && handle === selfHandle) {
      return makeDecision(item, {
        verdict: 'ALLOW',
        scope: 'TWEET',
        matchedHandle: handle,
        source: 'self',
        reason: 'Own account exempt',
      });
    }

    if (item?.tweetId && allowedTweetsSet.has(String(item.tweetId))) {
      return makeDecision(item, {
        verdict: 'ALLOW',
        scope: 'TWEET',
        matchedHandle: handle,
        source: 'allowed_tweet',
        reason: 'Single tweet marked as not slop',
      });
    }

    if (handle && whitelistSet.has(handle)) {
      return makeDecision(item, {
        verdict: 'ALLOW',
        scope: 'TWEET',
        matchedHandle: handle,
        source: 'whitelist',
        reason: 'Account in whitelist',
      });
    }

    const candidates = [handle, rtHandle, quotedHandle].filter(Boolean);
    for (const candidate of candidates) {
      if (whitelistSet.has(candidate)) continue;
      if (blacklistSet.has(candidate)) {
        return makeDecision(item, {
          verdict: 'SLOP',
          scope: 'ACCOUNT',
          matchedHandle: candidate,
          source: 'blacklist',
          reason: `Account @${candidate} is blacklisted`,
        });
      }
    }

    for (const candidate of candidates) {
      if (whitelistSet.has(candidate)) continue;
      if (sessionAccountsSet.has(candidate)) {
        return makeDecision(item, {
          verdict: 'SLOP',
          scope: 'ACCOUNT',
          matchedHandle: candidate,
          source: 'session_account',
          reason: `Session slop account @${candidate}`,
        });
      }
    }

    if (item?.tweetId && blockedTweetsSet.has(String(item.tweetId))) {
      return makeDecision(item, {
        verdict: 'SLOP',
        scope: 'TWEET',
        matchedHandle: handle,
        source: 'user_block',
        reason: 'Hidden by user',
      });
    }

    return makeDecision(item, {
      verdict: 'ALLOW',
      scope: 'TWEET',
      matchedHandle: handle,
      source: 'allow',
      reason: 'Local check clean',
    });
  }

  function shouldQueryAiClassifier(item, aiScanScope = 'replies') {
    if (!item || typeof item !== 'object') return false;
    const text = (item.text || '').trim();
    const quotedText = (item.quotedText || '').trim();
    if (!text && !quotedText) return false;
    if (normalizeAiScanScope(aiScanScope) === 'replies' && !item.isReply && !quotedText) {
      return false;
    }

    const combined = `${text} ${quotedText}`.trim();
    const hasSignal = /https?:\/\/|t\.co\/|\$\w{2,8}|@[a-z0-9_]+|\bdm\b|私信|空投|回复|评论/i.test(combined);
    if (combined.length < 8 && !hasSignal) return false;
    return true;
  }

  function clampProb(val, fallback = 0) {
    const num = Number(val);
    if (!Number.isFinite(num)) return fallback;
    return Number(Math.max(0, Math.min(1, num)).toFixed(3));
  }

  function readNoul(ans) {
    if (!ans || typeof ans !== 'object') return { prob: null, confidence: 0 };
    const raw = ans.noul ?? ans.probability;
    const prob = typeof raw === 'number' && Number.isFinite(raw) ? clampProb(raw) : null;
    const rawConf = ans.confidence;
    const confidence =
      typeof rawConf === 'number' && Number.isFinite(rawConf)
        ? clampProb(rawConf)
        : prob !== null
          ? clampProb(Math.min(1, 0.5 + Math.abs(prob - 0.5)))
          : 0;
    return { prob, confidence };
  }

  function readChoice(ans) {
    if (!ans || typeof ans !== 'object') return { choice: '', confidence: 0 };
    const raw = ans.choice ?? ans.selected_option ?? ans.selectedOption ?? '';
    return {
      choice: typeof raw === 'string' ? raw.trim() : String(raw || '').trim(),
      confidence: clampProb(ans.confidence, 0.75),
    };
  }

  async function postWithTimeout(fetchImpl, url, headers, bodyObj, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyObj),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, error: `HTTP_${res.status}` };
      return { ok: true, data: await res.json() };
    } catch (err) {
      return { ok: false, error: err?.message || 'AI_REQUEST_FAILED' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function classifyWithAi(items = [], aiConfig = {}, fetchImpl = (...args) => globalScope.fetch(...args)) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const apiKey = String(aiConfig.apiKey || '').trim();
    const baseUrl = normalizeBaseUrl(aiConfig.baseUrl || DEFAULT_AI_BASE_URL) || DEFAULT_AI_BASE_URL;
    const model = String(aiConfig.model || DEFAULT_AI_MODEL).trim() || DEFAULT_AI_MODEL;
    const timeoutMs = Math.max(1500, Number(aiConfig.timeoutMs) || 8000);

    if (!apiKey || typeof fetchImpl !== 'function') {
      return items.map((item) =>
        makeDecision(item, {
          verdict: 'ALLOW',
          scope: 'TWEET',
          matchedHandle: item.handle,
          source: 'ai_fallback_allow',
          reason: 'AI key unavailable',
        })
      );
    }

    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
    const out = [];
    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      const uniqueParents = [];
      const parentSeen = new Set();
      for (const it of chunk) {
        const pText = String(it.parentText || '').trim().slice(0, 240);
        if (!pText) continue;
        const pHandle = normalizeHandle(it.parentHandle) || '';
        const key = `${pHandle}|${pText}`;
        if (!parentSeen.has(key)) {
          parentSeen.add(key);
          uniqueParents.push({ key, handle: pHandle, text: pText });
        }
      }
      const sharedParent = uniqueParents.length === 1 ? uniqueParents[0] : null;
      const header = sharedParent
        ? `SharedParentPost${sharedParent.handle ? ` (@${sharedParent.handle})` : ''}: ${sharedParent.text}\n\n=== ITEMS ===\n\n`
        : '';

      const input =
        header +
        chunk
          .map((item, idx) => {
            const handle = normalizeHandle(item.handle) || 'unknown';
            const isVerified = Boolean(item.isVerified);
            const pText = String(item.parentText || '').trim().slice(0, 240);
            const pHandle = normalizeHandle(item.parentHandle) || '';
            const needsOwnParent = Boolean(pText && (!sharedParent || `${pHandle}|${pText}` !== sharedParent.key));
            return [
              `[${idx}] Handle: @${handle}`,
              isVerified ? 'VerifiedBlue: yes' : null,
              item.displayName ? `DisplayName: ${String(item.displayName).slice(0, 80)}` : null,
              item.isRetweet ? 'Type: RETWEET' : item.isReply ? 'Type: REPLY' : 'Type: TWEET',
              needsOwnParent ? `ParentPost${pHandle ? ` (@${pHandle})` : ''}: ${pText}` : null,
              `Text: ${String(item.text || '').slice(0, 400)}`,
              item.quotedHandle ? `QuotedHandle: @${normalizeHandle(item.quotedHandle)}` : null,
              item.quotedText ? `QuotedText: ${String(item.quotedText).slice(0, 280)}` : null,
            ]
              .filter(Boolean)
              .join('\n');
          })
          .join('\n\n---\n\n');

      const questions = {};
      const trueDesc =
        '1) AI reply-guy / blue-check impression farming: restating or summarizing the Parent Post in pompous generic truisms (e.g. "本质是...", "最终回到商业账本/护城河") with zero new facts or personal experience; ' +
        '2) Keyword-hooked hollow metaphors or generic cheerleading that picks terms from the Parent Post just to sound clever without substance; ' +
        '3) Engagement bait ("comment X for DM"), crypto airdrop/wallet/rebate shills, templated rage-bait, or off-topic spam.';
      const falseDesc =
        'Genuine human post or reply contributing concrete facts, specific technical details, real personal experience, sharp direct disagreement, specific questions, grounded humor, or original news/updates.';

      for (let idx = 0; idx < chunk.length; idx += 1) {
        const item = chunk[idx];
        questions[`p_${idx}_slop`] = {
          type: 'noul',
          instructions: `Evaluate ONLY item [${idx}]. Is item [${idx}] X/Twitter slop (especially AI reply-guy filler, engagement-farming truisms, or spam) that should be hidden?`,
          criteria: { true_description: trueDesc, false_description: falseDesc },
        };
        if (item.quotedText || item.quotedHandle) {
          questions[`p_${idx}_target`] = {
            type: 'choice',
            instructions: `For item [${idx}], if it contains slop, where is the slop located?`,
            criteria: {
              OUTER: 'The outer post itself is slop/spam.',
              QUOTED_ONLY: 'Only the quoted post is slop while the outer author is making a normal comment/reaction.',
            },
          };
        }
      }

      const resp = await postWithTimeout(fetchImpl, baseUrl, headers, { model, input, questions }, timeoutMs);

      if (!resp.ok) {
        for (const item of chunk) {
          out.push({
            ...makeDecision(item, {
              verdict: 'ALLOW',
              scope: 'TWEET',
              matchedHandle: item.handle,
              source: 'ai_fallback_allow',
              reason: resp.error,
            }),
            slopProb: 0,
          });
        }
        continue;
      }

      const answers = resp.data?.answers || {};
      for (let idx = 0; idx < chunk.length; idx += 1) {
        const item = chunk[idx];
        const handle = normalizeHandle(item.handle);
        const quotedHandle = normalizeHandle(item.quotedHandle);
        const slopAns = readNoul(answers[`p_${idx}_slop`]);
        const probThreshold = item.isReply ? 0.65 : 0.72;
        const confThreshold = item.isReply ? 0.55 : 0.6;
        const isSlop = slopAns.prob !== null && slopAns.prob >= probThreshold && slopAns.confidence >= confThreshold;

        if (!isSlop) {
          out.push({
            ...makeDecision(item, {
              verdict: 'ALLOW',
              scope: 'TWEET',
              matchedHandle: handle,
              source: 'ai_model',
              reason: 'Decisions clean',
            }),
            slopProb: slopAns.prob ?? 0,
          });
          continue;
        }

        let matchedHandle = handle;
        if (item.quotedText || item.quotedHandle) {
          const target = readChoice(answers[`p_${idx}_target`]);
          if (target.choice === 'QUOTED_ONLY' && quotedHandle) {
            matchedHandle = quotedHandle;
          }
        }

        out.push({
          ...makeDecision(item, {
            verdict: 'SLOP',
            scope: 'TWEET',
            matchedHandle,
            source: 'ai_model',
            reason: `Decisions p=${slopAns.prob} c=${slopAns.confidence}`,
          }),
          slopProb: slopAns.prob,
        });
      }
    }
    return out;
  }

  function describeRuntimeStatus(settings = {}, stats = {}, effectiveFlywheelUrl = '') {
    if (!settings?.enabled) {
      return {
        visible: true,
        tone: 'muted',
        text: '已暂停',
        detail: '总开关已关闭，X 页面保持原样',
      };
    }

    const hasFlywheel = Boolean(settings?.flywheelEnabled && effectiveFlywheelUrl);
    const hasByok = Boolean(settings?.aiEnabled && settings?.aiApiKey);

    if (hasByok && hasFlywheel) {
      if (stats?.backendOnline) {
        return {
          visible: true,
          tone: 'ok',
          text: 'AI 直连 + 飞轮',
          detail: '新帖由自有密钥直连判别，共享黑名单正常同步',
        };
      }
      if (!stats?.lastSyncAt && !stats?.lastError) {
        return {
          visible: true,
          tone: 'ok',
          text: 'AI 直连 + 飞轮',
          detail: '新帖由自有密钥直连判别，正在同步共享黑名单',
        };
      }
      return {
        visible: true,
        tone: 'err',
        text: 'AI 直连（飞轮异常）',
        detail: '自有密钥直连正常，但共享黑名单同步失败',
      };
    }

    if (hasByok) {
      return {
        visible: true,
        tone: 'ok',
        text: 'AI 直连',
        detail: '使用自有密钥判别新帖，仅使用本机黑白名单',
      };
    }

    if (hasFlywheel) {
      if (stats?.backendOnline) {
        return {
          visible: true,
          tone: 'ok',
          text: '飞轮在线',
          detail: '已连接公共飞轮实时判帖与同步黑名单',
        };
      }
      if (!stats?.lastSyncAt && !stats?.lastError) {
        return {
          visible: true,
          tone: 'muted',
          text: '飞轮连接中',
          detail: '正在同步共享黑名单',
        };
      }
      return {
        visible: true,
        tone: 'err',
        text: '连接异常',
        detail: stats?.lastError ? `飞轮暂不可达 (${stats.lastError})` : '飞轮暂不可达，当前使用本机名单过滤',
      };
    }

    return {
      visible: true,
      tone: 'muted',
      text: '仅本机名单',
      detail: '未开启云端与直连判帖，仅按本机黑白名单过滤',
    };
  }

  function describeInterceptEntry(entry = {}) {
    const authorHandle = normalizeHandle(entry?.handle || entry?.matchedHandle || '');
    const matchedHandle = normalizeHandle(entry?.matchedHandle || entry?.handle || '');
    const isAccountOnly = String(entry?.tweetId || '').startsWith('acct_');
    const isIndirect = Boolean(authorHandle && matchedHandle && authorHandle !== matchedHandle);
    const isSingleUserBlock = entry?.source === 'user_block' && entry?.scope === 'TWEET';
    const isManualAccountBlock = entry?.source === 'user_block' && entry?.scope === 'ACCOUNT';

    let badge = '单条命中';
    if (isSingleUserBlock) {
      badge = '手动屏蔽';
    } else if (isManualAccountBlock) {
      badge = '手动拉黑';
    } else if (isIndirect && normalizeHandle(entry?.quotedHandle) === matchedHandle) {
      badge = `引用 @${matchedHandle}`;
    } else if (isIndirect) {
      badge = `关联 @${matchedHandle}`;
    } else if (entry?.scope === 'ACCOUNT' || entry?.source === 'blacklist' || entry?.source === 'session_account') {
      badge = '黑名单账号';
    }

    return {
      authorHandle,
      matchedHandle,
      isAccountOnly,
      isIndirect,
      isSingleUserBlock,
      isManualAccountBlock,
      badge,
    };
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
          resolve(null);
          return;
        }
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(resp);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function el(tag, props = null, children = null) {
    const node = document.createElement(tag);
    if (props && typeof props === 'object') {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'text') node.textContent = String(v);
        else if (k === 'className') node.className = v;
        else if (k === 'dataset' && typeof v === 'object') {
          for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv);
        } else if (k === 'attrs' && typeof v === 'object') {
          for (const [ak, av] of Object.entries(v)) {
            if (av !== undefined && av !== null) node.setAttribute(ak, String(av));
          }
        } else if (k.startsWith('on') && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'style' && typeof v === 'object') {
          Object.assign(node.style, v);
        } else {
          node[k] = v;
        }
      }
    }
    const list = Array.isArray(children) ? children : children != null ? [children] : [];
    for (const child of list) {
      if (child === undefined || child === null || child === false) continue;
      node.appendChild(
        typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child
      );
    }
    return node;
  }

  const CORNER_GLYPHS_6X9 = {
    1: ['..##..', '.###..', '####..', '..##..', '..##..', '..##..', '..##..', '######', '######'],
    2: ['.####.', '######', '##..##', '...##.', '..##..', '.##...', '##....', '######', '######'],
    3: ['.####.', '######', '....##', '..###.', '..###.', '....##', '##..##', '######', '.####.'],
    4: ['...##.', '..###.', '.####.', '##.##.', '##.##.', '######', '######', '...##.', '...##.'],
    5: ['######', '######', '##....', '#####.', '.#####', '....##', '##..##', '######', '.####.'],
    6: ['.####.', '######', '##....', '#####.', '######', '##..##', '##..##', '######', '.####.'],
    7: ['######', '######', '....##', '...##.', '..##..', '..##..', '.##...', '.##...', '.##...'],
    8: ['.####.', '######', '##..##', '##..##', '.####.', '##..##', '##..##', '######', '.####.'],
    9: ['.####.', '######', '##..##', '##..##', '######', '.#####', '....##', '######', '.####.'],
  };

  const CORNER_GLYPHS_4X7 = {
    0: ['.##.', '#..#', '#..#', '#..#', '#..#', '#..#', '.##.'],
    1: ['.##.', '###.', '.##.', '.##.', '.##.', '.##.', '####'],
    2: ['.##.', '#..#', '...#', '..#.', '.#..', '#...', '####'],
    3: ['###.', '...#', '...#', '.##.', '...#', '...#', '###.'],
    4: ['#..#', '#..#', '#..#', '####', '...#', '...#', '...#'],
    5: ['####', '#...', '#...', '###.', '...#', '#..#', '.##.'],
    6: ['.##.', '#...', '#...', '###.', '#..#', '#..#', '.##.'],
    7: ['####', '...#', '...#', '..#.', '.#..', '.#..', '.#..'],
    8: ['.##.', '#..#', '#..#', '.##.', '#..#', '#..#', '.##.'],
    9: ['.##.', '#..#', '#..#', '.###', '...#', '...#', '.##.'],
  };

  const CORNER_GLYPHS_3X5 = {
    1: ['.#.', '##.', '.#.', '.#.', '###'],
    2: ['###', '..#', '###', '#..', '###'],
    3: ['###', '..#', '.##', '..#', '###'],
    4: ['#.#', '#.#', '###', '..#', '..#'],
    5: ['###', '#..', '###', '..#', '###'],
    6: ['###', '#..', '###', '#.#', '###'],
    7: ['###', '..#', '..#', '.#.', '.#.'],
    8: ['###', '#.#', '###', '#.#', '###'],
    9: ['###', '#.#', '###', '..#', '###'],
  };

  const CORNER_PLUS_3X3 = ['.#.', '###', '.#.'];
  const CORNER_PLUS_5X5 = ['..#..', '..#..', '#####', '..#..', '..#..'];
  const CORNER_COLOR_RGBA = [83, 229, 206, 255]; // #53E5CE

  function stampBitmap(rgbaBuffer, size, bitmap, startX, startY, bounds) {
    for (let dy = 0; dy < bitmap.length; dy += 1) {
      const row = bitmap[dy];
      const py = startY + dy;
      if (py < 0 || py >= size) continue;
      for (let dx = 0; dx < row.length; dx += 1) {
        if (row[dx] !== '#') continue;
        const px = startX + dx;
        if (px < 0 || px >= size) continue;
        const idx = (py * size + px) * 4;
        rgbaBuffer[idx] = CORNER_COLOR_RGBA[0];
        rgbaBuffer[idx + 1] = CORNER_COLOR_RGBA[1];
        rgbaBuffer[idx + 2] = CORNER_COLOR_RGBA[2];
        rgbaBuffer[idx + 3] = CORNER_COLOR_RGBA[3];
        if (px < bounds.minX) bounds.minX = px;
        if (py < bounds.minY) bounds.minY = py;
        if (px > bounds.maxX) bounds.maxX = px;
        if (py > bounds.maxY) bounds.maxY = py;
      }
    }
  }

  function paintToolbarCornerCount(rgbaBuffer, size, count) {
    const num = Math.max(0, Math.floor(Number(count) || 0));
    if (!rgbaBuffer || num <= 0 || (size !== 16 && size !== 32)) {
      return { painted: false, label: '', bounds: null };
    }

    const bounds = { minX: size, minY: size, maxX: -1, maxY: -1 };
    let label = '';

    if (size === 32) {
      if (num <= 9) {
        label = String(num);
        stampBitmap(rgbaBuffer, size, CORNER_GLYPHS_6X9[num], 4, 3, bounds);
      } else if (num <= 99) {
        label = String(num);
        const tens = Math.floor(num / 10);
        const ones = num % 10;
        stampBitmap(rgbaBuffer, size, CORNER_GLYPHS_4X7[tens], 2, 4, bounds);
        stampBitmap(rgbaBuffer, size, CORNER_GLYPHS_4X7[ones], 7, 4, bounds);
      } else {
        label = '99+';
        stampBitmap(rgbaBuffer, size, CORNER_GLYPHS_4X7[9], 2, 5, bounds);
        stampBitmap(rgbaBuffer, size, CORNER_GLYPHS_4X7[9], 7, 5, bounds);
        stampBitmap(rgbaBuffer, size, CORNER_PLUS_3X3, 11, 2, bounds);
      }
    } else {
      if (num <= 9) {
        label = String(num);
        stampBitmap(rgbaBuffer, size, CORNER_GLYPHS_3X5[num], 2, 1, bounds);
      } else {
        label = '9+';
        stampBitmap(rgbaBuffer, size, CORNER_PLUS_5X5, 1, 1, bounds);
      }
    }

    return {
      painted: bounds.maxX >= bounds.minX,
      label,
      bounds: bounds.maxX >= bounds.minX ? bounds : null,
    };
  }

  const BAKU_STAGES = [
    {
      id: 'fawn',
      level: 1,
      name: '幼貘',
      enName: 'Fawn',
      minCount: 0,
      asset: 'assets/stages/baku-stage-1.webp',
      tagline: '刚醒来，正学着认出第一批水帖',
      petLines: [
        '幼貘晃了晃白边小耳',
        '刚醒不久，正等你带它去逛 X',
        '小小一团，先把眼前的水帖认熟',
      ],
    },
    {
      id: 'scout',
      level: 2,
      name: '寻貘',
      enName: 'Scout',
      minCount: 10,
      asset: 'assets/stages/baku-stage-2.webp',
      tagline: '褪去幼斑，顺着评论区寻味清帖',
      petLines: [
        '寻貘伸长鼻子嗅了嗅时间线',
        '斑点褪净，已经认得出水帖气味',
        '四足落地，正稳步巡视评论区',
      ],
    },
    {
      id: 'baku',
      level: 3,
      name: '静貘',
      enName: 'Baku',
      minCount: 100,
      asset: 'assets/stages/baku-stage-3.webp',
      tagline: '黑白成体，静默守候你的时间线',
      petLines: [
        '静貘闭目点点头，一切照常清净',
        '不弹提示，只把噪声安静收走',
        '守着时间线，只留真正在说话的人',
      ],
    },
    {
      id: 'sage',
      level: 4,
      name: '禅貘',
      enName: 'Sage',
      minCount: 500,
      asset: 'assets/stages/baku-stage-4.webp',
      tagline: '吞帖数百，云气渐生，宠辱不惊',
      petLines: [
        '禅貘吐出一缕霁青清风',
        '吃过数百条水帖，早已见怪不怪',
        '肩起云纹，嘈杂评论区照样安稳',
      ],
    },
    {
      id: 'astral',
      level: 5,
      name: '栖星',
      enName: 'Astral',
      minCount: 2500,
      asset: 'assets/stages/baku-stage-5.webp',
      tagline: '踏云栖星，万帖过眼，只留真话',
      petLines: [
        '栖星微微颔首，时间线已如静水',
        '踏云而坐，千百杂念皆化作星尘',
        '已至终态，继续替你守住这片清净',
      ],
    },
  ];

  function getBakuStageIndex(stageId) {
    if (typeof stageId !== 'string' || !stageId) return -1;
    return BAKU_STAGES.findIndex((s) => s.id === stageId);
  }

  function resolveBakuStage(filteredCount = 0) {
    const num = Number(filteredCount);
    const count = Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
    let index = 0;
    for (let i = 0; i < BAKU_STAGES.length; i += 1) {
      if (count >= BAKU_STAGES[i].minCount) index = i;
    }
    const stage = BAKU_STAGES[index];
    const nextStage = index + 1 < BAKU_STAGES.length ? BAKU_STAGES[index + 1] : null;
    const isMax = !nextStage;
    const remaining = nextStage ? Math.max(0, nextStage.minCount - count) : 0;
    const progress = nextStage
      ? Math.max(0, Math.min(1, (count - stage.minCount) / (nextStage.minCount - stage.minCount)))
      : 1;

    return {
      stage,
      index,
      count,
      nextStage,
      isMax,
      remaining,
      progress,
    };
  }

  const exported = {
    DEFAULT_FLYWHEEL_URL,
    DEFAULT_AI_BASE_URL,
    DEFAULT_AI_MODEL,
    DEFAULT_SETTINGS,
    BAKU_STAGES,
    getBakuStageIndex,
    resolveBakuStage,
    normalizeDisplayMode,
    normalizeBadgeMode,
    normalizeAiScanScope,
    normalizeBaseUrl,
    normalizeSettings,
    resolveFlywheelUrl,
    normalizeHandle,
    extractTweetData,
    evaluateLocalRules,
    shouldQueryAiClassifier,
    classifyWithAi,
    describeRuntimeStatus,
    describeInterceptEntry,
    paintToolbarCornerCount,
    sendMessage,
    el,
  };

  globalScope.AntiSlopShared = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);

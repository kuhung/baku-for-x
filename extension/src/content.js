(function () {
  if (typeof window.__antislopCleanup === 'function') {
    try {
      window.__antislopCleanup();
    } catch {
      // ignore stale cleanup failure
    }
  }

  const {
    DEFAULT_FLYWHEEL_URL,
    normalizeSettings,
    resolveFlywheelUrl,
    extractTweetData,
    evaluateLocalRules,
    shouldQueryAiClassifier,
    isDiscoverMoreHeadingText,
    normalizeDisplayMode,
    normalizeHandle,
    sendMessage,
    el,
  } = window.AntiSlopShared;

  const ARTICLE_SELECTOR = 'article[data-testid="tweet"], article[role="article"]';
  const MAX_LOCAL_VERDICT_CACHE = 1500;
  const VERDICT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  const MAX_SESSION_ACCOUNTS = 500;
  const MAX_REPORTED_INTERCEPT_IDS = 4000;
  const AI_QUEUE_DEBOUNCE_MS = 60;
  const LOCAL_INTERCEPT_DEBOUNCE_MS = 250;
  const FALLBACK_SCAN_DEBOUNCE_MS = 150;
  const AUTO_COLLAPSE_MS = 190;

  const getExtUrl = (path) =>
    typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function'
      ? chrome.runtime.getURL(path)
      : '';
  const ASSET_URLS = {
    triggerIdle: getExtUrl('assets/baku-trigger-idle.png'),
    triggerAlert: getExtUrl('assets/baku-trigger-alert.png'),
    eatSprite: getExtUrl('assets/baku-eat-sprite.png'),
    toastMunch: getExtUrl('assets/baku-toast-munch.webp'),
  };

  let currentSettings = normalizeSettings();
  let effectiveFlywheelUrl = resolveFlywheelUrl(currentSettings, DEFAULT_FLYWHEEL_URL);
  let localRulesReady = false;
  let rawRemoteBlacklist = new Set();
  let rawLocalBlacklist = new Set();
  const localLists = {
    whitelistSet: new Set(),
    blacklistSet: new Set(),
    sessionAccountsSet: new Set(),
    blockedTweetsSet: new Set(),
    allowedTweetsSet: new Set(),
  };
  const localVerdictCache = new Map();
  const reportedLocalInterceptIds = new Set();
  const localInterceptQueue = new Map();

  const processedArticles = new WeakMap();
  const eatingControllers = new WeakMap();
  const autoCollapsingControllers = new WeakMap();
  const userExpandedTweetIds = new Set();
  const streakRevealedTweetIds = new Set();
  const pageFilteredTweetIds = new Set();
  const activeStabilizeCleanups = new Set();

  let pendingQueue = new Map();
  let flushTimer = null;
  let scanTimer = null;
  let localInterceptTimer = null;
  let activeToastTimer = null;
  let lastPathname = window.location.pathname;
  let lastSyncedBadgeCount = -1;
  let activeFloatingMenuKey = null;
  let activeFloatingMenuAnchor = null;
  let cachedFocalPost = null;
  let cachedFocalArticleEl = null;
  let cachedDiscoverMoreEl = null;
  let cachedSelfHandle = '';
  let lastThemeAttr = '';
  let bodyThemeObserver = null;

  function isDecisionAllowed(result) {
    return !result || result.verdict === 'ALLOW';
  }

  const toHandleSet = (arr) => new Set((Array.isArray(arr) ? arr : []).map(normalizeHandle).filter(Boolean));
  const toIdSet = (arr) => new Set((Array.isArray(arr) ? arr : []).filter(Boolean).map(String));

  function rebuildEffectiveBlacklist() {
    const next = new Set();
    for (const h of rawRemoteBlacklist) {
      if (!localLists.whitelistSet.has(h)) next.add(h);
    }
    for (const h of rawLocalBlacklist) {
      if (!localLists.whitelistSet.has(h)) next.add(h);
    }
    localLists.blacklistSet = next;
  }

  function applyLocalListsSnapshot({
    settings = null,
    effectiveFlywheelUrl: nextUrl = null,
    remoteBlacklist = null,
    localBlacklist = null,
    whitelist = null,
    blockedTweets = null,
    allowedTweets = null,
  } = {}) {
    if (settings) {
      currentSettings = normalizeSettings(settings);
      effectiveFlywheelUrl =
        typeof nextUrl === 'string' ? nextUrl : resolveFlywheelUrl(currentSettings, DEFAULT_FLYWHEEL_URL);
    }
    if (remoteBlacklist !== null) rawRemoteBlacklist = toHandleSet(remoteBlacklist);
    if (localBlacklist !== null) rawLocalBlacklist = toHandleSet(localBlacklist);
    if (whitelist !== null) localLists.whitelistSet = toHandleSet(whitelist);
    if (blockedTweets !== null) localLists.blockedTweetsSet = toIdSet(blockedTweets);
    if (allowedTweets !== null) localLists.allowedTweetsSet = toIdSet(allowedTweets);
    rebuildEffectiveBlacklist();
  }

  function readLocalVerdict(tweetId) {
    if (!tweetId) return null;
    const key = String(tweetId);
    const entry = localVerdictCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      localVerdictCache.delete(key);
      return null;
    }
    localVerdictCache.delete(key);
    localVerdictCache.set(key, entry);
    return entry.value;
  }

  function writeLocalVerdict(tweetId, value, expiresAt = Date.now() + VERDICT_CACHE_TTL_MS) {
    if (!tweetId || !value) return;
    const exp = Number(expiresAt);
    if (!Number.isFinite(exp) || exp <= Date.now()) return;
    const key = String(tweetId);
    if (localVerdictCache.has(key)) localVerdictCache.delete(key);
    localVerdictCache.set(key, { expiresAt: exp, value });
    while (localVerdictCache.size > MAX_LOCAL_VERDICT_CACHE) {
      localVerdictCache.delete(localVerdictCache.keys().next().value);
    }
  }

  function clearLocalVerdict({ tweetId = null, handle = '' } = {}) {
    if (tweetId) localVerdictCache.delete(String(tweetId));
    const norm = normalizeHandle(handle);
    if (norm) {
      localLists.sessionAccountsSet.delete(norm);
      for (const [k, entry] of Array.from(localVerdictCache.entries())) {
        if (
          normalizeHandle(entry?.value?.handle) === norm ||
          normalizeHandle(entry?.value?.matchedHandle) === norm
        ) {
          localVerdictCache.delete(k);
        }
      }
    }
  }

  function addLocalSessionAccount(handle) {
    const norm = normalizeHandle(handle);
    if (!norm) return;
    localLists.sessionAccountsSet.delete(norm);
    localLists.sessionAccountsSet.add(norm);
    while (localLists.sessionAccountsSet.size > MAX_SESSION_ACCOUNTS) {
      localLists.sessionAccountsSet.delete(localLists.sessionAccountsSet.values().next().value);
    }
  }

  function canQueryAi(item) {
    if (!shouldQueryAiClassifier(item, currentSettings.aiScanScope)) return false;
    const hasByok = Boolean(currentSettings.aiEnabled && currentSettings.aiApiKey);
    return hasByok || Boolean(effectiveFlywheelUrl);
  }

  function readStorageLocal(keys) {
    return new Promise((resolve) => {
      try {
        const localArea = typeof chrome !== 'undefined' ? chrome.storage?.local : null;
        if (!localArea || typeof localArea.get !== 'function') {
          resolve({});
          return;
        }
        localArea.get(keys, (res) => {
          resolve(chrome.runtime?.lastError || !res || typeof res !== 'object' ? {} : res);
        });
      } catch {
        resolve({});
      }
    });
  }

  async function hydrateFromLocalStorage() {
    const hasLocalGet = typeof chrome !== 'undefined' && typeof chrome.storage?.local?.get === 'function';
    if (!hasLocalGet) return false;
    const res = await readStorageLocal([
      'antislop_settings',
      'antislop_blacklist',
      'antislop_local_blacklist',
      'antislop_whitelist',
      'antislop_blocked_tweets',
      'antislop_allowed_tweets',
    ]);
    applyLocalListsSnapshot({
      settings: res.antislop_settings || null,
      remoteBlacklist: res.antislop_blacklist || [],
      localBlacklist: res.antislop_local_blacklist || [],
      whitelist: res.antislop_whitelist || [],
      blockedTweets: res.antislop_blocked_tweets || [],
      allowedTweets: res.antislop_allowed_tweets || [],
    });
    localRulesReady = true;
    return true;
  }

  async function hydrateFromSnapshot() {
    const snap = await sendMessage({ type: 'GET_CLIENT_SNAPSHOT' });
    if (snap && snap.settings) {
      applyLocalListsSnapshot(snap);
      localLists.sessionAccountsSet = toHandleSet(snap.sessionAccounts);
      localVerdictCache.clear();
      if (Array.isArray(snap.verdictCache)) {
        for (const pair of snap.verdictCache) {
          if (Array.isArray(pair) && pair[0] && pair[1]?.value) {
            writeLocalVerdict(pair[0], pair[1].value, pair[1].expiresAt);
          }
        }
      }
      localRulesReady = true;
      return true;
    }
    localRulesReady = true;
    return false;
  }

  function flushLocalInterceptQueue() {
    localInterceptTimer = null;
    if (localInterceptQueue.size === 0 || !currentSettings.enabled) return;
    const entries = Array.from(localInterceptQueue.values());
    localInterceptQueue.clear();
    sendMessage({ type: 'RECORD_LOCAL_INTERCEPTS', entries });
  }

  function enqueueLocalInterceptReport(item, result) {
    if (!currentSettings.enabled || !item?.tweetId || !result || result.verdict !== 'SLOP') return;
    const idStr = String(item.tweetId);
    if (reportedLocalInterceptIds.has(idStr)) return;
    reportedLocalInterceptIds.add(idStr);
    while (reportedLocalInterceptIds.size > MAX_REPORTED_INTERCEPT_IDS) {
      reportedLocalInterceptIds.delete(reportedLocalInterceptIds.values().next().value);
    }
    if (!localInterceptQueue.has(idStr)) {
      localInterceptQueue.set(idStr, { item, result });
    }
    if (!localInterceptTimer) {
      localInterceptTimer = setTimeout(flushLocalInterceptQueue, LOCAL_INTERCEPT_DEBOUNCE_MS);
    }
  }

  function removeArticleFromPendingQueue(articleEl) {
    if (!articleEl || pendingQueue.size === 0) return;
    for (const [key, entry] of Array.from(pendingQueue.entries())) {
      if (entry.articleEl === articleEl) {
        pendingQueue.delete(key);
      }
    }
  }

  function detectTheme() {
    try {
      if (!document.body || typeof getComputedStyle !== 'function') return 'dim';
      const bg = getComputedStyle(document.body).backgroundColor || '';
      const nums = bg.match(/\d+/g);
      if (nums && nums.length >= 3) {
        const lum = (Number(nums[0]) * 299 + Number(nums[1]) * 587 + Number(nums[2]) * 114) / 1000;
        return lum > 160 ? 'light' : Number(nums[0]) < 10 && Number(nums[1]) < 10 ? 'lights-out' : 'dim';
      }
    } catch {
      // ignore
    }
    return 'dim';
  }

  function syncThemeAttr() {
    const next = detectTheme();
    if (next === lastThemeAttr) return;
    lastThemeAttr = next;
    document.documentElement?.setAttribute?.('data-antislop-theme', next);
  }

  function attachBodyThemeObserver() {
    if (bodyThemeObserver || !document.body || typeof MutationObserver !== 'function') return;
    syncThemeAttr();
    bodyThemeObserver = new MutationObserver(() => syncThemeAttr());
    bodyThemeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
  }

  function preloadAssets() {
    if (typeof Image !== 'function') return;
    for (const url of [ASSET_URLS.triggerIdle, ASSET_URLS.triggerAlert]) {
      if (!url) continue;
      try {
        const img = new Image();
        img.src = url;
      } catch {
        // ignore
      }
    }
  }

  function detectSelfHandle() {
    if (cachedSelfHandle) return cachedSelfHandle;
    const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (switcher) {
      for (const sp of switcher.querySelectorAll('span')) {
        const txt = (sp.textContent || '').trim();
        if (txt.startsWith('@') && txt.length > 1 && txt.length <= 32) {
          cachedSelfHandle = normalizeHandle(txt);
          return cachedSelfHandle;
        }
      }
    }
    const profileLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    const m = (profileLink?.getAttribute?.('href') || '').match(/^\/([A-Za-z0-9_]{1,30})\/?$/);
    if (m) {
      cachedSelfHandle = normalizeHandle(m[1]);
      return cachedSelfHandle;
    }
    return '';
  }

  function getFocalTweetId() {
    const m = (window.location.pathname || '').match(/^\/(?:i\/web|[A-Za-z0-9_]{1,30})\/status\/(\d+)/i);
    return m ? m[1] : null;
  }

  function computeFingerprint(item) {
    return [
      item.tweetId || '',
      item.handle || '',
      item.retweeterHandle || '',
      item.quotedHandle || '',
      item.isReply ? '1' : '0',
      (item.text || '').length,
      (item.quotedText || '').length,
    ].join('|');
  }

  function isSameTweetNode(prevItem, nextItem) {
    if (!prevItem || !nextItem) return false;
    const idA = String(prevItem.tweetId || '');
    const idB = String(nextItem.tweetId || '');
    if (idA && idB && idA === idB) return true;
    const isDomA = idA.startsWith('dom_');
    const isDomB = idB.startsWith('dom_');
    if (isDomA !== isDomB) {
      const hA = normalizeHandle(prevItem.handle);
      const hB = normalizeHandle(nextItem.handle);
      if (hA && hB && hA === hB) return true;
    }
    return false;
  }

  function cancelAutoCollapse(articleEl) {
    if (!articleEl) return;
    const ctrl = autoCollapsingControllers.get(articleEl);
    if (ctrl) {
      ctrl.cancelled = true;
      if (ctrl.rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(ctrl.rafId);
      }
      if (ctrl.timerId) clearTimeout(ctrl.timerId);
      autoCollapsingControllers.delete(articleEl);
    }
    articleEl.classList?.remove?.('antislop-auto-collapsing');
    if (articleEl.getAttribute?.('data-antislop-state') === 'collapsing') {
      if (articleEl.style) articleEl.style.maxHeight = '';
      articleEl.removeAttribute('data-antislop-state');
    }
  }

  function cancelEatingAnimation(articleEl) {
    if (!articleEl) return;
    const ctrl = eatingControllers.get(articleEl);
    if (ctrl) {
      ctrl.cancelled = true;
      for (const timerId of ctrl.timers) clearTimeout(timerId);
      eatingControllers.delete(articleEl);
    }
    articleEl.classList?.remove?.('antislop-eating-collapsing');
    if (articleEl.style) {
      articleEl.style.maxHeight = '';
      articleEl.style.opacity = '';
      articleEl.style.transition = '';
    }
    if (articleEl.getAttribute?.('data-antislop-state') === 'eating') {
      articleEl.removeAttribute('data-antislop-state');
    }
    articleEl.querySelectorAll(':scope > .antislop-eat-stage').forEach((n) => n.remove());
  }

  function restoreArticle(articleEl) {
    cancelEatingAnimation(articleEl);
    cancelAutoCollapse(articleEl);
    articleEl.removeAttribute('data-antislop-state');
    articleEl.querySelectorAll(':scope > [data-antislop-masked-inert="1"]').forEach((child) => {
      child.inert = false;
      child.removeAttribute('aria-hidden');
      child.removeAttribute('data-antislop-masked-inert');
    });
    articleEl.querySelectorAll(':scope > .antislop-mask-overlay').forEach((n) => n.remove());
    articleEl
      .querySelectorAll('.antislop-report-wrap[data-antislop-expanded-controls="1"]')
      .forEach((n) => n.remove());
  }

  function syncBadgeCount() {
    const nextCount = currentSettings.enabled ? pageFilteredTweetIds.size : 0;
    if (nextCount === lastSyncedBadgeCount) return;
    lastSyncedBadgeCount = nextCount;
    sendMessage({ type: 'UPDATE_BADGE', count: nextCount });
  }

  function shouldCompletelyHide(item, result) {
    if (normalizeDisplayMode(currentSettings.displayMode) !== 'hide') return false;
    if (item?.tweetId && streakRevealedTweetIds.has(item.tweetId)) return false;
    const focalTweetId = getFocalTweetId();
    if (focalTweetId && item && String(item.tweetId || '') === focalTweetId) return false;

    const pathMatch = (window.location.pathname || '').match(
      /^\/([A-Za-z0-9_]{1,30})(?:\/(?:with_replies|highlights|media|likes))?\/?$/i
    );
    if (pathMatch) {
      const profileHandle = normalizeHandle(pathMatch[1]);
      if (
        profileHandle &&
        (profileHandle === normalizeHandle(item?.handle) ||
          profileHandle === normalizeHandle(result?.matchedHandle))
      ) {
        return false;
      }
    }
    return true;
  }

  function itemMatchesHandle(item, targetHandle) {
    const norm = normalizeHandle(targetHandle);
    if (!item || !norm) return false;
    return (
      normalizeHandle(item.handle) === norm ||
      normalizeHandle(item.retweeterHandle) === norm ||
      normalizeHandle(item.quotedHandle) === norm
    );
  }

  function closeFloatingMenu({ restoreFocus = false } = {}) {
    document.querySelectorAll('.antislop-floating-menu').forEach((n) => n.remove());
    if (activeFloatingMenuAnchor) {
      activeFloatingMenuAnchor.setAttribute('aria-expanded', 'false');
      if (restoreFocus && activeFloatingMenuAnchor.isConnected) {
        activeFloatingMenuAnchor.focus();
      }
      activeFloatingMenuAnchor = null;
    }
    activeFloatingMenuKey = null;
  }

  function openFloatingMenu(anchorEl, options, menuKey = '') {
    const wasSame = menuKey && activeFloatingMenuKey === menuKey;
    closeFloatingMenu();
    if (wasSame) return;

    activeFloatingMenuKey = menuKey || `menu_${Date.now()}`;
    activeFloatingMenuAnchor = anchorEl;
    if (anchorEl) {
      anchorEl.setAttribute('aria-haspopup', 'menu');
      anchorEl.setAttribute('aria-expanded', 'true');
    }
    syncThemeAttr();

    const menuItems = [];
    const menu = el(
      'div',
      { className: 'antislop-floating-menu', attrs: { 'data-antislop-ui': '1', role: 'menu' } },
      options.map((opt) => {
        const itemBtn = el(
          'button',
          {
            type: 'button',
            attrs: { role: 'menuitem' },
            onClick: async (e) => {
              e.preventDefault();
              e.stopPropagation();
              closeFloatingMenu();
              await opt.onClick();
            },
          },
          [opt.label, opt.sub ? el('span', { className: 'antislop-menu-sub', text: opt.sub }) : null]
        );
        menuItems.push(itemBtn);
        return itemBtn;
      })
    );

    menu.addEventListener('keydown', (e) => {
      if (!menuItems.length) return;
      const curIdx = menuItems.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        menuItems[(curIdx + 1) % menuItems.length].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        menuItems[(curIdx - 1 + menuItems.length) % menuItems.length].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        menuItems[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        menuItems[menuItems.length - 1].focus();
      } else if (e.key === 'Tab') {
        closeFloatingMenu();
      }
    });

    (document.body || document.documentElement).appendChild(menu);

    const anchorRect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const pad = 8;
    const top =
      anchorRect.bottom + 4 + menuRect.height > window.innerHeight - pad
        ? Math.max(pad, anchorRect.top - menuRect.height - 4)
        : anchorRect.bottom + 4;
    let left = anchorRect.right - menuRect.width;
    if (left < pad) left = Math.max(pad, anchorRect.left);
    if (left + menuRect.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - menuRect.width - pad);
    }
    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
    if (menuItems[0]) menuItems[0].focus({ preventScroll: true });
  }

  function showToast(messageText, actions = [], { mascot = false } = {}) {
    document.querySelectorAll('.antislop-toast').forEach((n) => n.remove());
    if (activeToastTimer) {
      clearTimeout(activeToastTimer);
      activeToastTimer = null;
    }

    const validActions = Array.isArray(actions)
      ? actions.filter((a) => a && a.label && typeof a.onClick === 'function')
      : [];

    let toastHovered = false;
    let toast = null;
    const scheduleHide = (delayMs) => {
      if (activeToastTimer) clearTimeout(activeToastTimer);
      activeToastTimer = setTimeout(() => {
        activeToastTimer = null;
        if (!toastHovered && toast?.isConnected) toast.remove();
      }, delayMs);
    };

    toast = el('div', { className: 'antislop-toast', attrs: { 'data-antislop-ui': '1', role: 'status' } }, [
      mascot && ASSET_URLS.toastMunch
        ? el('img', {
            className: 'antislop-toast-mascot',
            src: ASSET_URLS.toastMunch,
            width: 28,
            height: 28,
            alt: '',
            attrs: { draggable: 'false' },
          })
        : null,
      el('span', { className: 'antislop-toast-text', text: messageText }),
      validActions.length > 0
        ? el(
            'div',
            { className: 'antislop-toast-actions' },
            validActions.map((act) =>
              el('button', {
                type: 'button',
                className: act.primary ? 'antislop-toast-btn is-primary' : 'antislop-toast-btn',
                text: act.label,
                onClick: (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (activeToastTimer) {
                    clearTimeout(activeToastTimer);
                    activeToastTimer = null;
                  }
                  toast.remove();
                  act.onClick();
                },
              })
            )
          )
        : null,
    ]);

    toast.addEventListener('mouseenter', () => {
      toastHovered = true;
      if (activeToastTimer) {
        clearTimeout(activeToastTimer);
        activeToastTimer = null;
      }
    });
    toast.addEventListener('mouseleave', () => {
      toastHovered = false;
      scheduleHide(2500);
    });

    (document.body || document.documentElement).appendChild(toast);
    scheduleHide(5000);
  }

  function restoreSingleArticle(articleEl, item, sourceTag) {
    if (!articleEl?.isConnected) return;
    if (item?.tweetId) {
      userExpandedTweetIds.delete(item.tweetId);
      streakRevealedTweetIds.delete(item.tweetId);
      pageFilteredTweetIds.delete(item.tweetId);
    }
    restoreArticle(articleEl);
    ensureReportButton(articleEl, item);
    processedArticles.set(articleEl, {
      fingerprint: computeFingerprint(item),
      item,
      result: { verdict: 'ALLOW', scope: 'TWEET', source: sourceTag },
      renderedKey: 'allow',
    });
    syncBadgeCount();
    updateHiddenStreakIndicators();
  }

  function restoreMatchingArticles(normTarget, sourceTag) {
    document.querySelectorAll(ARTICLE_SELECTOR).forEach((node) => {
      const meta = processedArticles.get(node);
      const elItem = meta?.item || extractTweetData(node);
      if (elItem && itemMatchesHandle(elItem, normTarget)) {
        if (elItem.tweetId) {
          userExpandedTweetIds.delete(elItem.tweetId);
          streakRevealedTweetIds.delete(elItem.tweetId);
          pageFilteredTweetIds.delete(elItem.tweetId);
        }
        restoreArticle(node);
        ensureReportButton(node, elItem);
        processedArticles.set(node, {
          fingerprint: meta?.fingerprint || computeFingerprint(elItem),
          item: elItem,
          result: { verdict: 'ALLOW', scope: 'TWEET', source: sourceTag },
          renderedKey: 'allow',
        });
      }
    });
    syncBadgeCount();
    updateHiddenStreakIndicators();
  }

  async function triggerWhitelistRecovery(targetHandle, tweetId, itemSnapshot) {
    const normTarget = normalizeHandle(targetHandle);
    if (!normTarget) return;
    localLists.whitelistSet.add(normTarget);
    rawLocalBlacklist.delete(normTarget);
    rawRemoteBlacklist.delete(normTarget);
    rebuildEffectiveBlacklist();
    if (tweetId) localLists.blockedTweetsSet.delete(String(tweetId));
    clearLocalVerdict({ handle: normTarget, tweetId });

    restoreMatchingArticles(normTarget, 'whitelist');
    const actionPromise = sendMessage({
      type: 'WHITELIST_ACCOUNT',
      payload: { handle: normTarget, tweetId, itemSnapshot },
    });
    showToast(`已信任 @${normTarget}`, [
      {
        label: '撤销',
        onClick: async () => {
          const res = await actionPromise;
          await sendMessage({
            type: 'UNDO_WHITELIST_ACCOUNT',
            payload: {
              handle: normTarget,
              wasLocalBlacklisted: Boolean(res?.wasLocalBlacklisted),
              wasRemoteBlacklisted: Boolean(res?.wasRemoteBlacklisted),
              entrySnapshots: res?.removedEntries?.length
                ? res.removedEntries
                : itemSnapshot
                  ? [itemSnapshot]
                  : [],
            },
          });
          localLists.whitelistSet.delete(normTarget);
          if (res?.wasLocalBlacklisted) rawLocalBlacklist.add(normTarget);
          if (res?.wasRemoteBlacklisted) rawRemoteBlacklist.add(normTarget);
          rebuildEffectiveBlacklist();
          clearLocalVerdict({ handle: normTarget, tweetId });
          scanTweets({ reapplyOnly: true });
        },
      },
    ]);
    await actionPromise;
  }

  function attachDecisionSnapshot(item, result) {
    if (!item || !result) return item || null;
    return {
      ...item,
      origVerdict: result.verdict || '',
      origSlopProb: result.slopProb ?? null,
      origSource: result.source || '',
    };
  }

  async function triggerAllowSingleTweet(articleEl, item) {
    if (!item?.tweetId) return;
    const idStr = String(item.tweetId);
    const prevResult = processedArticles.get(articleEl)?.result || null;
    const snapshot = attachDecisionSnapshot(item, prevResult);
    localLists.allowedTweetsSet.add(idStr);
    localLists.blockedTweetsSet.delete(idStr);
    clearLocalVerdict({ tweetId: idStr });

    restoreSingleArticle(articleEl, item, 'allowed_tweet');
    const actionPromise = sendMessage({
      type: 'ALLOW_TWEET',
      payload: { tweetId: item.tweetId, itemSnapshot: snapshot },
    });
    showToast('已放行此条推文', [
      {
        label: '撤销',
        onClick: async () => {
          const res = await actionPromise;
          await sendMessage({
            type: 'UNDO_ALLOW_TWEET',
            payload: { tweetId: item.tweetId, entrySnapshot: res?.removedEntry || item },
          });
          localLists.allowedTweetsSet.delete(idStr);
          clearLocalVerdict({ tweetId: idStr });
          scanTweets({ reapplyOnly: true });
        },
      },
    ]);
    await actionPromise;
  }

  async function triggerUnblockAccount(targetHandle, tweetId) {
    const normTarget = normalizeHandle(targetHandle);
    if (!normTarget) return;
    rawLocalBlacklist.delete(normTarget);
    rawRemoteBlacklist.delete(normTarget);
    rebuildEffectiveBlacklist();
    clearLocalVerdict({ handle: normTarget });

    restoreMatchingArticles(normTarget, 'undo');
    await sendMessage({ type: 'UNBLOCK_ACCOUNT', payload: { handle: normTarget, tweetId } });
  }

  async function triggerUnblockTweet(articleEl, item) {
    if (!item?.tweetId) return;
    const idStr = String(item.tweetId);
    localLists.blockedTweetsSet.delete(idStr);
    clearLocalVerdict({ tweetId: idStr });

    restoreSingleArticle(articleEl, item, 'undo');
    await sendMessage({ type: 'UNBLOCK_TWEET', payload: { tweetId: item.tweetId } });
  }

  async function eatSingleTweetWithAnimation(articleEl, latest) {
    if (!currentSettings.enabled || !latest || !articleEl || eatingControllers.has(articleEl)) return;
    cancelAutoCollapse(articleEl);
    closeFloatingMenu();
    if (latest.tweetId) {
      const idStr = String(latest.tweetId);
      userExpandedTweetIds.delete(idStr);
      pageFilteredTweetIds.add(idStr);
      localLists.blockedTweetsSet.add(idStr);
      localLists.allowedTweetsSet.delete(idStr);
      clearLocalVerdict({ tweetId: idStr });
      syncBadgeCount();
    }

    const decision = {
      verdict: 'SLOP',
      scope: 'TWEET',
      matchedHandle: latest.handle,
      source: 'user_block',
    };
    const fp = computeFingerprint(latest);
    const primary = normalizeHandle(latest.handle);

    const toastActions = [];
    if (primary) {
      toastActions.push({
        label: `拉黑 @${primary}`,
        primary: true,
        onClick: () => {
          cancelEatingAnimation(articleEl);
          blockAccountFromItem(primary, latest);
        },
      });
    }
    toastActions.push({
      label: '撤销',
      onClick: () => {
        cancelEatingAnimation(articleEl);
        triggerUnblockTweet(articleEl, latest);
      },
    });
    showToast('已吞掉这条', toastActions, { mascot: true });

    const prevResult = processedArticles.get(articleEl)?.result || null;
    const reportPromise = sendMessage({
      type: 'REPORT_SLOP',
      payload: {
        handle: latest.handle,
        displayName: latest.displayName || '',
        tweetId: latest.tweetId,
        scope: 'tweet',
        text: latest.text,
        quotedHandle: latest.quotedHandle || '',
        quotedText: latest.quotedText || '',
        parentHandle: latest.parentHandle || '',
        parentText: latest.parentText || '',
        isReply: Boolean(latest.isReply),
        isVerified: Boolean(latest.isVerified),
        origVerdict: prevResult?.verdict || '',
        origSlopProb: prevResult?.slopProb ?? null,
        origSource: prevResult?.source || '',
      },
    });

    const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    const willHide = shouldCompletelyHide(latest, decision);
    if (reducedMotion || !willHide || !ASSET_URLS.eatSprite || !articleEl.isConnected) {
      applyDecision(articleEl, latest, decision, fp, { animate: false });
      updateHiddenStreakIndicators();
      await reportPromise;
      return;
    }

    const beforeRect = articleEl.getBoundingClientRect();
    const startH = Math.max(48, Math.round(beforeRect.height));
    const shouldCompensate = window.scrollY > 80 && beforeRect.height > 60 && beforeRect.bottom > 0 && beforeRect.top < 0;

    processedArticles.set(articleEl, {
      fingerprint: fp,
      item: latest,
      result: decision,
      renderedKey: 'eating',
    });
    articleEl.setAttribute('data-antislop-state', 'eating');

    const eatStage = el(
      'div',
      {
        className: 'antislop-eat-stage',
        attrs: { 'data-antislop-ui': '1', 'aria-hidden': 'true' },
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
        },
      },
      [
        el('div', { className: 'antislop-eat-sparkles' }, [
          el('span', { className: 'antislop-eat-sparkle is-s1' }),
          el('span', { className: 'antislop-eat-sparkle is-s2' }),
          el('span', { className: 'antislop-eat-sparkle is-s3' }),
        ]),
        el('div', {
          className: 'antislop-eat-sprite',
          style: { backgroundImage: `url("${ASSET_URLS.eatSprite}")` },
        }),
      ]
    );
    articleEl.appendChild(eatStage);

    const ctrl = { cancelled: false, timers: [] };
    eatingControllers.set(articleEl, ctrl);

    const tCollapse = setTimeout(() => {
      if (ctrl.cancelled || !articleEl.isConnected) return;
      articleEl.style.maxHeight = `${startH}px`;
      void articleEl.offsetHeight;
      articleEl.classList.add('antislop-eating-collapsing');
    }, 440);

    const tFinish = setTimeout(() => {
      eatingControllers.delete(articleEl);
      if (ctrl.cancelled) return;
      if (!articleEl.isConnected) return;
      articleEl.classList.remove('antislop-eating-collapsing');
      articleEl.style.maxHeight = '';
      articleEl.style.opacity = '';
      articleEl.style.transition = '';
      eatStage.remove();
      applyDecision(articleEl, latest, decision, fp, { animate: false });
      if (shouldCompensate) {
        const delta = articleEl.getBoundingClientRect().height - beforeRect.height;
        if (delta < -10) window.scrollBy(0, delta);
      }
      updateHiddenStreakIndicators();
    }, 640);

    ctrl.timers.push(tCollapse, tFinish);
    await reportPromise;
  }

  async function blockAccountFromItem(targetHandle, curItem) {
    if (!currentSettings.enabled) return;
    const normTarget = normalizeHandle(targetHandle);
    if (!normTarget) return;

    rawLocalBlacklist.add(normTarget);
    localLists.whitelistSet.delete(normTarget);
    rebuildEffectiveBlacklist();
    clearLocalVerdict({ handle: normTarget });

    const matchedTweetIds = [];
    const seenIds = new Set();
    const track = (tItem) => {
      if (!tItem?.tweetId) return;
      const idStr = String(tItem.tweetId);
      userExpandedTweetIds.delete(idStr);
      streakRevealedTweetIds.delete(idStr);
      localLists.allowedTweetsSet.delete(idStr);
      if (!seenIds.has(idStr)) {
        seenIds.add(idStr);
        matchedTweetIds.push(idStr);
      }
    };

    let prevResult = null;
    if (curItem && itemMatchesHandle(curItem, normTarget)) track(curItem);
    document.querySelectorAll(ARTICLE_SELECTOR).forEach((node) => {
      const meta = processedArticles.get(node);
      if (
        !prevResult &&
        curItem &&
        (meta?.item === curItem || (curItem.tweetId && meta?.item?.tweetId === curItem.tweetId))
      ) {
        prevResult = meta.result || null;
      }
      const elItem = meta?.item || extractTweetData(node);
      if (elItem && itemMatchesHandle(elItem, normTarget)) {
        track(elItem);
        applyDecision(
          node,
          elItem,
          { verdict: 'SLOP', scope: 'ACCOUNT', matchedHandle: normTarget, source: 'user_block' },
          meta?.fingerprint,
          { animate: false }
        );
      }
    });

    updateHiddenStreakIndicators();
    showToast(
      `已拉黑 @${normTarget}`,
      [{ label: '撤销', onClick: () => triggerUnblockAccount(normTarget, curItem?.tweetId || null) }],
      { mascot: true }
    );

    const isPrimary = normalizeHandle(curItem?.handle) === normTarget;
    await sendMessage({
      type: 'REPORT_SLOP',
      payload: {
        handle: normTarget,
        displayName: isPrimary && curItem ? curItem.displayName : '',
        tweetId: curItem ? curItem.tweetId : null,
        matchedTweetIds: currentSettings.enabled ? matchedTweetIds : [],
        scope: 'account',
        text: isPrimary && curItem ? curItem.text : '',
        quotedHandle: curItem ? curItem.quotedHandle : '',
        quotedText: curItem ? curItem.quotedText : '',
        parentHandle: isPrimary && curItem ? curItem.parentHandle || '' : '',
        parentText: isPrimary && curItem ? curItem.parentText || '' : '',
        isReply: Boolean(isPrimary && curItem && curItem.isReply),
        isVerified: Boolean(isPrimary && curItem && curItem.isVerified),
        origVerdict: isPrimary && prevResult ? prevResult.verdict || '' : '',
        origSlopProb: isPrimary && prevResult ? prevResult.slopProb ?? null : null,
        origSource: isPrimary && prevResult ? prevResult.source || '' : '',
      },
    });
  }

  function createRecoveryButtons(articleEl, item, result, targetHandle) {
    const isSingleBlock = result.source === 'user_block' && result.scope === 'TWEET';
    if (isSingleBlock) {
      return [
        el('button', {
          type: 'button',
          className: 'antislop-btn',
          text: '恢复',
          onClick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            triggerUnblockTweet(articleEl, item);
          },
        }),
      ];
    }

    const notSlopBtn = el('button', {
      type: 'button',
      className: 'antislop-btn',
      text: '不是 Slop',
      title: '放行这条或信任该账号',
      onClick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        const opts = [];
        if (item?.tweetId) {
          opts.push({
            label: '仅这条',
            sub: '只放行这一条推文',
            onClick: () => triggerAllowSingleTweet(articleEl, item),
          });
        }
        if (targetHandle) {
          const indirect = normalizeHandle(item?.handle) !== targetHandle;
          opts.push({
            label: indirect ? `信任关联账号 @${targetHandle}` : `信任账号 @${targetHandle}`,
            sub: '加入白名单，不再拦截该账号',
            onClick: () => triggerWhitelistRecovery(targetHandle, item?.tweetId || null, attachDecisionSnapshot(item, result)),
          });
        }
        if (opts.length === 1) opts[0].onClick();
        else if (opts.length > 1) openFloatingMenu(notSlopBtn, opts, `fp_${item?.tweetId || targetHandle}`);
      },
    });

    return [notSlopBtn];
  }

  function renderExpandedArticle(articleEl, item, result, fingerprint, renderedKey = '') {
    restoreArticle(articleEl);
    articleEl.setAttribute('data-antislop-state', 'expanded');
    if (renderedKey) {
      processedArticles.set(articleEl, {
        fingerprint: fingerprint || computeFingerprint(item),
        item,
        result,
        renderedKey,
      });
    }

    articleEl.querySelectorAll('.antislop-report-wrap').forEach((n) => n.remove());
    const actionGroup = articleEl.querySelector('[role="group"]');
    const anchor = actionGroup || articleEl.querySelector('[data-testid="User-Name"]');
    if (!anchor) return;

    const targetHandle = normalizeHandle(result.matchedHandle || item.handle);
    const wrap = el(
      'div',
      {
        className: actionGroup ? 'antislop-report-wrap antislop-in-actionbar' : 'antislop-report-wrap',
        attrs: { 'data-antislop-ui': '1', 'data-antislop-expanded-controls': '1' },
      },
      [
        el('button', {
          type: 'button',
          className: 'antislop-btn',
          text: '遮罩',
          onClick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (item?.tweetId) {
              userExpandedTweetIds.delete(item.tweetId);
              streakRevealedTweetIds.add(item.tweetId);
            }
            applyDecision(articleEl, item, result, fingerprint, { animate: false });
          },
        }),
        ...createRecoveryButtons(articleEl, item, result, targetHandle),
      ]
    );
    anchor.appendChild(wrap);
  }

  function renderMaskedArticle(articleEl, item, result, fingerprint, { animate = false } = {}) {
    restoreArticle(articleEl);
    articleEl.setAttribute('data-antislop-state', 'masked');

    for (const child of Array.from(articleEl.children)) {
      if (child.classList?.contains('antislop-mask-overlay')) continue;
      child.inert = true;
      child.setAttribute('aria-hidden', 'true');
      child.setAttribute('data-antislop-masked-inert', '1');
    }

    const targetHandle = normalizeHandle(result.matchedHandle || item.handle);
    const expandArticle = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (item?.tweetId) userExpandedTweetIds.add(item.tweetId);
      const expandedKey = computeRenderedKey(item, result);
      renderExpandedArticle(articleEl, item, result, fingerprint, expandedKey);
    };

    const overlay = el(
      'div',
      {
        className: animate ? 'antislop-mask-overlay is-entering' : 'antislop-mask-overlay',
        attrs: { 'data-antislop-ui': '1' },
        onClick: expandArticle,
      },
      [
        el('span', { className: 'antislop-mask-label' }, [
          el('span', { className: 'antislop-mask-badge', text: 'Slop' }),
          targetHandle ? el('span', { className: 'antislop-mask-handle', text: `@${targetHandle}` }) : null,
        ]),
        el('div', { className: 'antislop-mask-actions' }, [
          el('button', { type: 'button', className: 'antislop-btn', text: '展开', onClick: expandArticle }),
          ...createRecoveryButtons(articleEl, item, result, targetHandle),
        ]),
      ]
    );
    articleEl.appendChild(overlay);
  }

  function computeRenderedKey(item, result) {
    if (!currentSettings.enabled || isDecisionAllowed(result)) {
      return 'allow';
    }
    const targetHandle = normalizeHandle(result.matchedHandle || item?.handle);
    const isSingleBlock = result.source === 'user_block' && result.scope === 'TWEET' ? '1' : '0';
    if (item?.tweetId && userExpandedTweetIds.has(item.tweetId)) {
      return `expanded|${targetHandle}|${isSingleBlock}|${item.tweetId || ''}`;
    }
    if (shouldCompletelyHide(item, result)) {
      return 'hidden';
    }
    return `masked|${targetHandle}|${isSingleBlock}|${item?.tweetId || ''}`;
  }

  function isRenderedDomIntact(articleEl, renderedKey, item) {
    const state = articleEl.getAttribute?.('data-antislop-state') || '';
    if (renderedKey === 'allow') {
      if (state) return false;
      const selfHandle = detectSelfHandle();
      const itemHandle = normalizeHandle(item?.handle);
      const shouldHaveBtn = !(selfHandle && itemHandle && selfHandle === itemHandle);
      if (!shouldHaveBtn) {
        return !articleEl.querySelector('.antislop-report-wrap');
      }
      const existingWrap = articleEl.querySelector('.antislop-report-wrap');
      if (existingWrap) {
        if (existingWrap.hasAttribute('data-antislop-expanded-controls')) return false;
        if (!existingWrap.classList?.contains('antislop-in-actionbar') && articleEl.querySelector('[role="group"]')) {
          return false;
        }
        return true;
      }
      return !(articleEl.querySelector('[role="group"]') || articleEl.querySelector('[data-testid="User-Name"]'));
    }
    if (renderedKey === 'hidden') {
      return state === 'hidden' || state === 'collapsing';
    }
    if (renderedKey.startsWith('masked|')) {
      return state === 'masked' && Boolean(articleEl.querySelector(':scope > .antislop-mask-overlay'));
    }
    if (renderedKey.startsWith('expanded|')) {
      return (
        state === 'expanded' &&
        Boolean(articleEl.querySelector('.antislop-report-wrap[data-antislop-expanded-controls="1"]'))
      );
    }
    return false;
  }

  function applyDecision(articleEl, item, result, fingerprint, { animate = false } = {}) {
    const fp = fingerprint || computeFingerprint(item);
    const nextRenderedKey = computeRenderedKey(item, result);
    const existing = processedArticles.get(articleEl);

    if (!currentSettings.enabled || isDecisionAllowed(result)) {
      if (item?.tweetId) {
        pageFilteredTweetIds.delete(item.tweetId);
        syncBadgeCount();
      }
      if (existing?.renderedKey === nextRenderedKey && isRenderedDomIntact(articleEl, nextRenderedKey, item)) {
        processedArticles.set(articleEl, { fingerprint: fp, item, result, renderedKey: nextRenderedKey });
        return;
      }
      restoreArticle(articleEl);
      ensureReportButton(articleEl, item);
      processedArticles.set(articleEl, { fingerprint: fp, item, result, renderedKey: nextRenderedKey });
      return;
    }

    if (item?.tweetId) {
      pageFilteredTweetIds.add(item.tweetId);
      syncBadgeCount();
    }

    if (existing?.renderedKey === nextRenderedKey && isRenderedDomIntact(articleEl, nextRenderedKey, item)) {
      processedArticles.set(articleEl, { fingerprint: fp, item, result, renderedKey: nextRenderedKey });
      return;
    }

    processedArticles.set(articleEl, { fingerprint: fp, item, result, renderedKey: nextRenderedKey });

    if (nextRenderedKey.startsWith('expanded|')) {
      renderExpandedArticle(articleEl, item, result, fp, nextRenderedKey);
      return;
    }

    if (nextRenderedKey === 'hidden') {
      restoreArticle(articleEl);
      articleEl.setAttribute('data-antislop-state', 'hidden');
    } else {
      renderMaskedArticle(articleEl, item, result, fp, { animate });
    }
  }

  function collapseArticleSmoothly(articleEl, item, result, fingerprint, startHeight) {
    if (!articleEl?.isConnected) return;
    const fp = fingerprint || computeFingerprint(item);
    restoreArticle(articleEl);
    processedArticles.set(articleEl, {
      fingerprint: fp,
      item,
      result,
      renderedKey: 'hidden',
    });
    if (item?.tweetId) {
      pageFilteredTweetIds.add(item.tweetId);
      syncBadgeCount();
    }

    const h = Math.max(24, Math.round(Number(startHeight) || 0));
    articleEl.style.maxHeight = `${h}px`;
    articleEl.setAttribute('data-antislop-state', 'collapsing');

    const ctrl = { cancelled: false, rafId: null, timerId: null };
    autoCollapsingControllers.set(articleEl, ctrl);

    const scheduleFrame =
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 0);

    ctrl.rafId = scheduleFrame(() => {
      ctrl.rafId = null;
      if (ctrl.cancelled || !articleEl.isConnected) return;
      articleEl.classList.add('antislop-auto-collapsing');
    });

    ctrl.timerId = setTimeout(() => {
      autoCollapsingControllers.delete(articleEl);
      if (ctrl.cancelled || !articleEl.isConnected) return;
      articleEl.classList.remove('antislop-auto-collapsing');
      articleEl.style.maxHeight = '';
      articleEl.setAttribute('data-antislop-state', 'hidden');
      updateHiddenStreakIndicators();
    }, AUTO_COLLAPSE_MS);
  }

  function updateHiddenStreakIndicators() {
    if (!currentSettings.enabled || !getFocalTweetId()) {
      document.querySelectorAll('.antislop-streak-bar').forEach((n) => n.remove());
      return;
    }

    const desired = new Map();
    let streak = [];
    const flushStreak = () => {
      if (streak.length < 5) {
        streak = [];
        return;
      }
      const run = streak.slice();
      streak = [];
      const lastCell = run[run.length - 1].cell;
      const runIds = run.map((entry) => processedArticles.get(entry.article)?.item?.tweetId || '').join(',');
      desired.set(lastCell, { key: `${run.length}:${runIds}`, run });
    };

    for (const cell of document.querySelectorAll('[data-testid="cellInnerDiv"]')) {
      const hidden = cell.querySelector('article[data-antislop-state="hidden"]');
      const visible = cell.querySelector('article:not([data-antislop-state="hidden"])');
      if (hidden && !visible) streak.push({ cell, article: hidden });
      else flushStreak();
    }
    flushStreak();

    document.querySelectorAll('.antislop-streak-bar').forEach((bar) => {
      const cell = bar.parentElement;
      if (!cell || !desired.has(cell)) {
        bar.remove();
      }
    });

    for (const [lastCell, { key, run }] of desired.entries()) {
      const existingBar = Array.from(lastCell.children || []).find((ch) =>
        ch.classList?.contains?.('antislop-streak-bar')
      );
      if (existingBar && existingBar.getAttribute('data-antislop-streak-key') === key) {
        continue;
      }
      if (existingBar) existingBar.remove();

      const bar = el(
        'div',
        {
          className: 'antislop-streak-bar',
          attrs: { 'data-antislop-ui': '1', 'data-antislop-streak-key': key },
        },
        [
          el('span', { className: 'antislop-streak-text', text: `静貘已静默收起 ${run.length} 条 Slop 回复` }),
          el('button', {
            type: 'button',
            className: 'antislop-btn',
            text: '临时切换遮罩查看',
            onClick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              for (const entry of run) {
                const meta = processedArticles.get(entry.article);
                if (meta?.item?.tweetId) {
                  streakRevealedTweetIds.add(meta.item.tweetId);
                  applyDecision(entry.article, meta.item, meta.result, meta.fingerprint, { animate: false });
                }
              }
              updateHiddenStreakIndicators();
            },
          }),
        ]
      );
      lastCell.insertBefore(bar, lastCell.firstChild);
    }
  }

  function openReportContextMenu(anchorBtn, articleEl, getLatestItem) {
    const cur = getLatestItem() || {};
    const primary = normalizeHandle(cur.handle);
    const retweeter = normalizeHandle(cur.retweeterHandle);
    const quoted = normalizeHandle(cur.quotedHandle);
    const opts = [
      {
        label: '屏蔽这条',
        sub: '只收起这一条，不拉黑作者',
        onClick: () => eatSingleTweetWithAnimation(articleEl, getLatestItem()),
      },
    ];

    if (primary) {
      opts.push({
        label: `拉黑 @${primary}`,
        sub: '隐藏该账号的全部推文与回复',
        onClick: () => blockAccountFromItem(primary, getLatestItem()),
      });
    }
    if (retweeter && retweeter !== primary) {
      opts.push({ label: `拉黑转帖 @${retweeter}`, onClick: () => blockAccountFromItem(retweeter, getLatestItem()) });
    }
    if (quoted && quoted !== primary && quoted !== retweeter) {
      opts.push({ label: `拉黑引用 @${quoted}`, onClick: () => blockAccountFromItem(quoted, getLatestItem()) });
    }
    openFloatingMenu(anchorBtn, opts, `report_${cur.tweetId || primary}`);
  }

  function ensureReportButton(articleEl, item) {
    const selfHandle = detectSelfHandle();
    const itemHandle = normalizeHandle(item?.handle);
    if (selfHandle && itemHandle && selfHandle === itemHandle) {
      articleEl.querySelectorAll('.antislop-report-wrap').forEach((n) => n.remove());
      return;
    }

    const actionGroup = articleEl.querySelector('[role="group"]');
    const anchor = actionGroup || articleEl.querySelector('[data-testid="User-Name"]');
    if (!anchor) return;

    const existing = articleEl.querySelector('.antislop-report-wrap');
    if (existing) {
      const needsRelocate = Boolean(actionGroup && !existing.classList?.contains('antislop-in-actionbar'));
      if (existing.hasAttribute('data-antislop-expanded-controls') || needsRelocate) {
        existing.remove();
      } else {
        return;
      }
    }

    const getLatestItem = () => processedArticles.get(articleEl)?.item || extractTweetData(articleEl) || item;

    const triggerChildren = [];
    if (ASSET_URLS.triggerIdle) {
      triggerChildren.push(
        el('img', {
          className: 'antislop-baku-img is-idle',
          src: ASSET_URLS.triggerIdle,
          width: 19,
          height: 19,
          alt: '',
          attrs: { draggable: 'false', 'aria-hidden': 'true' },
        })
      );
    }
    if (ASSET_URLS.triggerAlert) {
      triggerChildren.push(
        el('img', {
          className: 'antislop-baku-img is-alert',
          src: ASSET_URLS.triggerAlert,
          width: 19,
          height: 19,
          alt: '',
          attrs: { draggable: 'false', 'aria-hidden': 'true' },
        })
      );
    }
    if (triggerChildren.length === 0) {
      triggerChildren.push(el('span', { text: 'Slop' }));
    }

    const btn = el(
      'button',
      {
        type: 'button',
        className: 'antislop-report-trigger',
        title: '喂给静貘：单击吞掉这条，右键更多选项',
        attrs: {
          'aria-label': '喂给静貘：单击吞掉这条，右键更多选项',
        },
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) {
            openReportContextMenu(btn, articleEl, getLatestItem);
            return;
          }
          eatSingleTweetWithAnimation(articleEl, getLatestItem());
        },
        onContextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          openReportContextMenu(btn, articleEl, getLatestItem);
        },
      },
      triggerChildren
    );

    anchor.appendChild(
      el(
        'div',
        {
          className: actionGroup ? 'antislop-report-wrap antislop-in-actionbar' : 'antislop-report-wrap',
          attrs: { 'data-antislop-ui': '1' },
        },
        btn
      )
    );
  }

  function collectCascadeSessionAccountTargets(accountHandle, selfHandle, alreadyCollected) {
    const norm = normalizeHandle(accountHandle);
    const out = [];
    if (!norm || (selfHandle && norm === selfHandle)) return out;

    document.querySelectorAll(ARTICLE_SELECTOR).forEach((node) => {
      if (alreadyCollected.has(node)) return;
      if (eatingControllers.has(node) || autoCollapsingControllers.has(node)) return;
      const meta = processedArticles.get(node);
      if (!meta?.item || !isDecisionAllowed(meta.result)) return;
      if (meta.result?.source === 'whitelist' || meta.result?.source === 'allowed_tweet' || meta.result?.source === 'self') {
        return;
      }
      if (itemMatchesHandle(meta.item, norm)) {
        out.push({
          articleEl: node,
          item: meta.item,
          fingerprint: meta.fingerprint,
          match: {
            verdict: 'SLOP',
            scope: 'ACCOUNT',
            matchedHandle: norm,
            source: 'session_account',
            reason: `Session slop account @${norm}`,
          },
        });
      }
    });
    return out;
  }

  function stabilizeAnchorAcrossFrames(anchorEl, initialTop) {
    let userScrolled = false;
    let anchorBeforeTop = initialTop;
    let remainingFrames = 2;
    let rafId = null;
    let cleanupTimer = null;

    const markUserScrolled = (e) => {
      if (
        e &&
        e.type === 'keydown' &&
        !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)
      ) {
        return;
      }
      userScrolled = true;
    };

    const cleanup = () => {
      if (rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
      rafId = null;
      if (cleanupTimer) clearTimeout(cleanupTimer);
      cleanupTimer = null;
      window.removeEventListener('wheel', markUserScrolled);
      window.removeEventListener('touchmove', markUserScrolled);
      window.removeEventListener('keydown', markUserScrolled);
      activeStabilizeCleanups.delete(cleanup);
    };

    window.addEventListener('wheel', markUserScrolled, { passive: true, once: true });
    window.addEventListener('touchmove', markUserScrolled, { passive: true, once: true });
    window.addEventListener('keydown', markUserScrolled, { passive: true });
    activeStabilizeCleanups.add(cleanup);
    cleanupTimer = setTimeout(cleanup, 100);

    const step = () => {
      rafId = null;
      if (userScrolled || !anchorEl.isConnected) {
        cleanup();
        return;
      }
      const drift = anchorEl.getBoundingClientRect().top - anchorBeforeTop;
      if (Math.abs(drift) > 2) {
        window.scrollBy(0, drift);
        anchorBeforeTop = anchorEl.getBoundingClientRect().top;
      }
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        rafId = requestAnimationFrame(step);
      } else {
        cleanup();
      }
    };

    rafId = requestAnimationFrame(step);
  }

  function applyAsyncSlopDecisionsWithStabilization(slopEntries, slopArticleSet) {
    const vh = window.innerHeight || document.documentElement?.clientHeight || 0;
    const scrollY = window.scrollY || 0;
    const aboveEntries = [];
    const visibleEntries = [];
    const belowEntries = [];

    for (const entry of slopEntries) {
      const rect = entry.articleEl.getBoundingClientRect();
      if (rect.bottom <= 0) {
        aboveEntries.push({ ...entry, rect });
      } else if (vh > 0 && rect.top >= vh) {
        belowEntries.push({ ...entry, rect });
      } else {
        visibleEntries.push({ ...entry, rect });
      }
    }

    let anchorEl = null;
    let anchorBeforeTop = 0;
    if (aboveEntries.length > 0 && scrollY > 20) {
      let fallbackEl = null;
      let fallbackTop = 0;
      for (const node of document.querySelectorAll(ARTICLE_SELECTOR)) {
        if (slopArticleSet.has(node)) continue;
        const st = node.getAttribute('data-antislop-state');
        if (st === 'hidden' || st === 'collapsing') continue;
        const r = node.getBoundingClientRect();
        if (r.height <= 0) continue;
        if (r.top >= 0 && (vh <= 0 || r.top < vh)) {
          anchorEl = node;
          anchorBeforeTop = r.top;
          break;
        }
        if (!fallbackEl && r.bottom > 40 && (vh <= 0 || r.top < vh)) {
          fallbackEl = node;
          fallbackTop = r.top;
        }
      }
      if (!anchorEl && fallbackEl) {
        anchorEl = fallbackEl;
        anchorBeforeTop = fallbackTop;
      }
    }

    const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

    for (const entry of belowEntries) {
      applyDecision(entry.articleEl, entry.item, entry.match, entry.fingerprint, { animate: false });
    }
    for (const entry of aboveEntries) {
      applyDecision(entry.articleEl, entry.item, entry.match, entry.fingerprint, { animate: false });
    }
    for (const entry of visibleEntries) {
      if (shouldCompletelyHide(entry.item, entry.match) && !reducedMotion && entry.rect.height > 20) {
        collapseArticleSmoothly(entry.articleEl, entry.item, entry.match, entry.fingerprint, entry.rect.height);
      } else {
        applyDecision(entry.articleEl, entry.item, entry.match, entry.fingerprint, { animate: !reducedMotion });
      }
    }

    if (anchorEl && typeof requestAnimationFrame === 'function') {
      stabilizeAnchorAcrossFrames(anchorEl, anchorBeforeTop);
    }
  }

  async function flushQueue() {
    flushTimer = null;
    if (pendingQueue.size === 0 || !currentSettings.enabled) return;

    const batchEntries = Array.from(pendingQueue.values());
    pendingQueue.clear();
    const resp = await sendMessage({ type: 'CLASSIFY_BATCH', items: batchEntries.map((e) => e.item) });
    if (!currentSettings.enabled) return;

    const results = Array.isArray(resp?.results) ? resp.results : [];
    const newlyCaughtAccounts = new Set();
    const allowEntries = [];
    const slopEntries = [];
    const slopArticleSet = new Set();

    for (const entry of batchEntries) {
      const match = results.find((r) => r && r.tweetId === entry.item.tweetId) || {
        tweetId: entry.item.tweetId,
        verdict: 'ALLOW',
        scope: 'TWEET',
        source: 'allow',
      };

      if (
        match.source &&
        match.source !== 'ai_fallback_allow' &&
        match.source !== 'rate_limited_allow' &&
        match.source !== 'disabled'
      ) {
        writeLocalVerdict(entry.item.tweetId, match);
      }
      const matchedHandle = normalizeHandle(match.matchedHandle);
      if (
        !isDecisionAllowed(match) &&
        match.scope === 'ACCOUNT' &&
        matchedHandle &&
        !localLists.whitelistSet.has(matchedHandle)
      ) {
        addLocalSessionAccount(matchedHandle);
        newlyCaughtAccounts.add(matchedHandle);
      }

      if (!entry.articleEl?.isConnected) continue;
      const currentMeta = processedArticles.get(entry.articleEl);
      if (currentMeta?.item && !isSameTweetNode(currentMeta.item, entry.item)) continue;
      if (eatingControllers.has(entry.articleEl) || autoCollapsingControllers.has(entry.articleEl)) continue;

      if (isDecisionAllowed(match)) {
        allowEntries.push({ ...entry, match });
      } else if (entry.item.tweetId && userExpandedTweetIds.has(entry.item.tweetId)) {
        allowEntries.push({ ...entry, match });
      } else {
        const curState = entry.articleEl.getAttribute?.('data-antislop-state');
        if (curState === 'hidden' || curState === 'masked') {
          applyDecision(entry.articleEl, entry.item, match, entry.fingerprint, { animate: false });
        } else {
          slopEntries.push({ ...entry, match });
          slopArticleSet.add(entry.articleEl);
        }
      }
    }

    if (newlyCaughtAccounts.size > 0) {
      const selfHandle = detectSelfHandle();
      for (const acct of newlyCaughtAccounts) {
        for (const extra of collectCascadeSessionAccountTargets(acct, selfHandle, slopArticleSet)) {
          slopEntries.push(extra);
          slopArticleSet.add(extra.articleEl);
        }
      }
    }

    for (const entry of allowEntries) {
      applyDecision(entry.articleEl, entry.item, entry.match, entry.fingerprint, { animate: false });
    }

    if (slopEntries.length > 0) {
      applyAsyncSlopDecisionsWithStabilization(slopEntries, slopArticleSet);
    }

    updateHiddenStreakIndicators();
  }

  function handleRouteChangeIfNeeded() {
    const curPath = window.location.pathname;
    if (curPath === lastPathname) return false;
    lastPathname = curPath;
    cachedFocalPost = null;
    cachedFocalArticleEl = null;
    cachedDiscoverMoreEl = null;
    pageFilteredTweetIds.clear();
    streakRevealedTweetIds.clear();
    closeFloatingMenu();
    syncBadgeCount();
    syncThemeAttr();
    return true;
  }

  function resolvePageContext(articlesForFullScan = null) {
    const focalTweetId = getFocalTweetId();
    if (!focalTweetId) {
      cachedFocalPost = null;
      cachedFocalArticleEl = null;
      cachedDiscoverMoreEl = null;
      return { focalTweetId: null, focalArticleEl: null, discoverMoreEl: null, newlyFoundFocal: false };
    }

    if (cachedFocalPost && cachedFocalPost.tweetId !== focalTweetId) {
      cachedFocalPost = null;
      cachedFocalArticleEl = null;
      cachedDiscoverMoreEl = null;
    }

    if (cachedFocalArticleEl && !cachedFocalArticleEl.isConnected) {
      cachedFocalArticleEl = null;
    }
    if (cachedDiscoverMoreEl && !cachedDiscoverMoreEl.isConnected) {
      cachedDiscoverMoreEl = null;
    }

    let newlyFoundFocal = false;
    if (!cachedFocalArticleEl) {
      const candidates = articlesForFullScan || document.querySelectorAll(ARTICLE_SELECTOR);
      for (const node of candidates) {
        if (node.querySelector?.(`a[href*="/status/${focalTweetId}"]`)) {
          const probe = extractTweetData(node);
          if (probe && String(probe.tweetId) === String(focalTweetId)) {
            cachedFocalArticleEl = node;
            cachedFocalPost = {
              tweetId: focalTweetId,
              handle: probe.handle || '',
              text: (probe.text || '').slice(0, 240),
            };
            newlyFoundFocal = true;
            break;
          }
        }
      }
    }

    if (!cachedDiscoverMoreEl) {
      const col = document.querySelector('[data-testid="primaryColumn"]') || document;
      const headingCandidates = col.querySelectorAll('h2, [role="heading"], [data-testid="cellInnerDiv"] span');
      for (const node of headingCandidates) {
        if (node.closest?.(ARTICLE_SELECTOR)) continue;
        if (isDiscoverMoreHeadingText(node.textContent || '')) {
          cachedDiscoverMoreEl = node;
          break;
        }
      }
    }

    return {
      focalTweetId,
      focalArticleEl: cachedFocalArticleEl,
      discoverMoreEl: cachedDiscoverMoreEl,
      newlyFoundFocal,
    };
  }

  function getArticleReplyContext(articleEl, pageCtx, articleIndex = -1, focalIndex = -1) {
    const { focalTweetId, focalArticleEl, discoverMoreEl } = pageCtx;
    if (!focalTweetId) return {};
    const inDiscoverMore = Boolean(
      discoverMoreEl &&
        typeof discoverMoreEl.compareDocumentPosition === 'function' &&
        (discoverMoreEl.compareDocumentPosition(articleEl) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
    if (inDiscoverMore) {
      return { focalTweetId, afterFocal: false, inDiscoverMore: true };
    }
    if (focalArticleEl) {
      if (articleEl === focalArticleEl) {
        return { focalTweetId, afterFocal: false, inDiscoverMore: false };
      }
      let isAfter = false;
      if (typeof focalArticleEl.compareDocumentPosition === 'function') {
        isAfter = Boolean(focalArticleEl.compareDocumentPosition(articleEl) & Node.DOCUMENT_POSITION_FOLLOWING);
      } else if (articleIndex >= 0 && focalIndex >= 0) {
        isAfter = articleIndex > focalIndex;
      }
      return { focalTweetId, afterFocal: isAfter, inDiscoverMore: false };
    }
    const afterFocal = Boolean(cachedFocalPost && cachedFocalPost.tweetId === focalTweetId);
    return { focalTweetId, afterFocal, inDiscoverMore: false };
  }

  function extractTweetWithContext(articleEl, pageCtx, selfHandle, articleIndex = -1, focalIndex = -1, fallbackItem = null) {
    const replyCtx = getArticleReplyContext(articleEl, pageCtx, articleIndex, focalIndex);
    const item =
      extractTweetData(
        articleEl,
        replyCtx.focalTweetId ? { focalTweetId: replyCtx.focalTweetId, afterFocal: replyCtx.afterFocal } : {}
      ) || fallbackItem;
    if (!item) return null;
    if (selfHandle) item.selfHandle = selfHandle;
    if (item.isReply && !replyCtx.inDiscoverMore && cachedFocalPost && cachedFocalPost.tweetId === replyCtx.focalTweetId) {
      item.parentHandle = cachedFocalPost.handle;
      item.parentText = cachedFocalPost.text;
    }
    return item;
  }

  function evaluateFastLocalAndCache(item, selfHandle) {
    const localRes = evaluateLocalRules(item, localLists, { selfHandle });
    if (localRes.verdict === 'SLOP' || localRes.source !== 'allow') {
      return { resolved: localRes, isKnown: true };
    }

    const cached = readLocalVerdict(item.tweetId);
    if (cached) {
      const cachedMatched = normalizeHandle(cached.matchedHandle);
      const resolved =
        cachedMatched && localLists.whitelistSet.has(cachedMatched)
          ? {
              ...cached,
              verdict: 'ALLOW',
              scope: 'TWEET',
              source: 'whitelist',
              reason: 'Account in whitelist',
            }
          : cached;
      if (resolved.verdict === 'SLOP' && resolved.scope === 'ACCOUNT' && cachedMatched) {
        addLocalSessionAccount(cachedMatched);
      }
      return { resolved, isKnown: true };
    }

    return { resolved: localRes, isKnown: false };
  }

  function processArticle(
    articleEl,
    { forceReprocess = false, reapplyOnly = false, allowAsyncAi = true, pageCtx = null, articleIndex = -1, focalIndex = -1 } = {}
  ) {
    if (!articleEl?.isConnected || !currentSettings.enabled || !localRulesReady) {
      return { changedVisibility: false };
    }
    if (eatingControllers.has(articleEl) || autoCollapsingControllers.has(articleEl)) {
      return { changedVisibility: false };
    }

    const ctx = pageCtx || resolvePageContext();
    const selfHandle = detectSelfHandle();
    const existing = processedArticles.get(articleEl);
    const item = extractTweetWithContext(
      articleEl,
      ctx,
      selfHandle,
      articleIndex,
      focalIndex,
      reapplyOnly ? existing?.item || null : null
    );
    if (!item) return { changedVisibility: false };

    const fingerprint = computeFingerprint(item);
    if (!reapplyOnly && !forceReprocess && existing && existing.fingerprint === fingerprint) {
      if (existing.renderedKey === 'allow' && !isRenderedDomIntact(articleEl, 'allow', item)) {
        ensureReportButton(articleEl, item);
      }
      return { changedVisibility: false };
    }

    if (existing && !isSameTweetNode(existing.item, item)) {
      if (existing.item?.tweetId && pageFilteredTweetIds.delete(existing.item.tweetId)) {
        syncBadgeCount();
      }
      restoreArticle(articleEl);
      articleEl.querySelectorAll('.antislop-report-wrap').forEach((n) => n.remove());
    } else if (existing?.item?.tweetId && existing.item.tweetId !== item.tweetId) {
      if (pageFilteredTweetIds.delete(existing.item.tweetId)) {
        syncBadgeCount();
      }
    }

    const prevState = articleEl.getAttribute?.('data-antislop-state');
    const { resolved, isKnown } = evaluateFastLocalAndCache(item, selfHandle);
    if (isKnown) {
      removeArticleFromPendingQueue(articleEl);
      applyDecision(articleEl, item, resolved, fingerprint, { animate: false });
      if (resolved.verdict === 'SLOP') enqueueLocalInterceptReport(item, resolved);
      return {
        changedVisibility: resolved.verdict === 'SLOP' && prevState !== articleEl.getAttribute?.('data-antislop-state'),
      };
    }

    if (reapplyOnly) {
      const prevResult = existing?.result;
      if (prevResult && !isDecisionAllowed(prevResult)) {
        applyDecision(articleEl, item, resolved, fingerprint, { animate: false });
      } else {
        applyDecision(articleEl, item, prevResult || resolved, fingerprint, { animate: false });
        return { changedVisibility: false };
      }
    } else {
      applyDecision(articleEl, item, resolved, fingerprint, { animate: false });
    }

    if (allowAsyncAi && canQueryAi(item)) {
      removeArticleFromPendingQueue(articleEl);
      pendingQueue.set(`${item.tweetId}:${fingerprint}`, { articleEl, item, fingerprint });
      if (!flushTimer) {
        flushTimer = setTimeout(flushQueue, AI_QUEUE_DEBOUNCE_MS);
      }
    }
    return { changedVisibility: false };
  }

  function scanTweets(options = {}) {
    const forceReprocess = typeof options === 'boolean' ? options : Boolean(options.forceReprocess);
    const reapplyOnly = typeof options === 'object' && Boolean(options.reapplyOnly);
    syncThemeAttr();
    handleRouteChangeIfNeeded();

    if (!currentSettings.enabled) {
      pendingQueue.clear();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pageFilteredTweetIds.clear();
      closeFloatingMenu();
      syncBadgeCount();
      document.querySelectorAll('.antislop-report-wrap').forEach((n) => n.remove());
      document.querySelectorAll(ARTICLE_SELECTOR).forEach(restoreArticle);
      updateHiddenStreakIndicators();
      return;
    }

    if (!localRulesReady) return;

    const articles = Array.from(document.querySelectorAll(ARTICLE_SELECTOR));
    const pageCtx = resolvePageContext(articles);
    const focalIndex = pageCtx.focalArticleEl ? articles.indexOf(pageCtx.focalArticleEl) : -1;

    for (let i = 0; i < articles.length; i += 1) {
      processArticle(articles[i], {
        forceReprocess,
        reapplyOnly,
        allowAsyncAi: true,
        pageCtx,
        articleIndex: i,
        focalIndex,
      });
    }

    syncBadgeCount();
    updateHiddenStreakIndicators();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanTweets(false);
    }, FALLBACK_SCAN_DEBOUNCE_MS);
  }

  function isOwnUiNode(node) {
    if (!node) return false;
    const nodeEl = node.nodeType === 1 ? node : node.parentElement;
    return Boolean(nodeEl?.closest?.('[data-antislop-ui="1"], .antislop-toast, .antislop-floating-menu'));
  }

  function getTabSummaryPayload() {
    return { ok: true, pageFilteredCount: pageFilteredTweetIds.size };
  }

  function peekTweetInPage(tweetId) {
    if (!tweetId) return { ok: false, found: false };
    const idStr = String(tweetId);
    for (const node of document.querySelectorAll(ARTICLE_SELECTOR)) {
      const meta = processedArticles.get(node);
      const item = meta?.item || extractTweetData(node);
      if (item && String(item.tweetId || '') === idStr) {
        userExpandedTweetIds.add(idStr);
        if (meta?.result && !isDecisionAllowed(meta.result)) {
          const expandedKey = computeRenderedKey(item, meta.result);
          renderExpandedArticle(node, item, meta.result, meta.fingerprint, expandedKey);
        }
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        node.classList.add('antislop-peek-highlight');
        setTimeout(() => node.classList.remove('antislop-peek-highlight'), 2200);
        return { ok: true, found: true };
      }
    }
    return { ok: true, found: false };
  }

  async function init() {
    syncThemeAttr();
    preloadAssets();
    attachBodyThemeObserver();

    const onDocContentLoaded = () => {
      attachBodyThemeObserver();
      syncThemeAttr();
      if (localRulesReady) scanTweets(false);
    };
    const onDocClick = (e) => {
      if (!isOwnUiNode(e.target)) closeFloatingMenu();
    };
    const onDocKeydown = (e) => {
      if (e.key === 'Escape' && activeFloatingMenuKey) {
        e.preventDefault();
        closeFloatingMenu({ restoreFocus: true });
      }
    };
    const onWinScroll = () => {
      if (activeFloatingMenuKey) closeFloatingMenu();
    };
    const onRuntimeMsg = (msg, _sender, sendResponse) => {
      if (msg?.type === 'GET_TAB_SUMMARY') sendResponse(getTabSummaryPayload());
      else if (msg?.type === 'PEEK_TWEET') sendResponse(peekTweetInPage(msg.tweetId));
      return false;
    };
    const onStorageChange = (changes, areaName) => {
      if (areaName !== 'local') return;
      let needsFullScan = false;
      let needsLocalReapply = false;

      if (changes.antislop_settings) {
        const prev = currentSettings;
        const next = normalizeSettings(changes.antislop_settings.newValue || {});
        const nextUrl = resolveFlywheelUrl(next, DEFAULT_FLYWHEEL_URL);
        const aiConfigChanged =
          next.aiEnabled !== prev.aiEnabled ||
          next.aiApiKey !== prev.aiApiKey ||
          next.aiBaseUrl !== prev.aiBaseUrl ||
          next.aiModel !== prev.aiModel ||
          next.aiScanScope !== prev.aiScanScope ||
          next.flywheelEnabled !== prev.flywheelEnabled ||
          nextUrl !== effectiveFlywheelUrl;
        const reEnabled = !prev.enabled && next.enabled;
        const disabledNow = prev.enabled && !next.enabled;

        currentSettings = next;
        effectiveFlywheelUrl = nextUrl;

        if (aiConfigChanged) {
          localVerdictCache.clear();
          needsFullScan = true;
        } else if (reEnabled || disabledNow) {
          needsFullScan = true;
        } else if (next.displayMode !== prev.displayMode) {
          needsLocalReapply = true;
        }
        lastSyncedBadgeCount = -1;
      }

      if (changes.antislop_whitelist) {
        localLists.whitelistSet = toHandleSet(changes.antislop_whitelist.newValue);
        rebuildEffectiveBlacklist();
        needsLocalReapply = true;
      }
      if (changes.antislop_blacklist) {
        rawRemoteBlacklist = toHandleSet(changes.antislop_blacklist.newValue);
        rebuildEffectiveBlacklist();
        needsLocalReapply = true;
      }
      if (changes.antislop_local_blacklist) {
        rawLocalBlacklist = toHandleSet(changes.antislop_local_blacklist.newValue);
        rebuildEffectiveBlacklist();
        needsLocalReapply = true;
      }
      if (changes.antislop_blocked_tweets) {
        localLists.blockedTweetsSet = toIdSet(changes.antislop_blocked_tweets.newValue);
        needsLocalReapply = true;
      }
      if (changes.antislop_allowed_tweets) {
        localLists.allowedTweetsSet = toIdSet(changes.antislop_allowed_tweets.newValue);
        needsLocalReapply = true;
      }

      if (needsFullScan) {
        scanTweets(true);
        syncBadgeCount();
      } else if (needsLocalReapply) {
        scanTweets({ reapplyOnly: true });
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onDocContentLoaded, { once: true });
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKeydown);
    window.addEventListener('scroll', onWinScroll, { passive: true });
    if (typeof chrome !== 'undefined') {
      chrome.runtime?.onMessage?.addListener(onRuntimeMsg);
      chrome.storage?.onChanged?.addListener(onStorageChange);
    }

    const observer = new MutationObserver((mutations) => {
      handleRouteChangeIfNeeded();
      if (!bodyThemeObserver && document.body) {
        attachBodyThemeObserver();
      }

      let hasExternal = false;
      const dirtyArticles = new Set();

      for (const m of mutations) {
        if (isOwnUiNode(m.target)) continue;
        const changedNodes = [...m.addedNodes, ...m.removedNodes];
        if (changedNodes.length > 0 && changedNodes.every(isOwnUiNode)) continue;
        hasExternal = true;

        const targetEl = m.target?.nodeType === 1 ? m.target : m.target?.parentElement;
        const enclosingArticle = targetEl?.closest?.(ARTICLE_SELECTOR);
        if (enclosingArticle) {
          dirtyArticles.add(enclosingArticle);
        }

        for (const node of m.addedNodes) {
          if (!node || node.nodeType !== 1 || isOwnUiNode(node)) continue;
          if (node.matches?.(ARTICLE_SELECTOR)) {
            dirtyArticles.add(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll(ARTICLE_SELECTOR).forEach((art) => dirtyArticles.add(art));
          }
          if (cachedDiscoverMoreEl == null && getFocalTweetId() && !node.closest?.(ARTICLE_SELECTOR)) {
            const text = node.textContent || '';
            if (text && text.length < 40 && isDiscoverMoreHeadingText(text)) {
              cachedDiscoverMoreEl = node;
            }
          }
        }
      }

      if (dirtyArticles.size > 0 && currentSettings.enabled && localRulesReady) {
        const pageCtx = resolvePageContext();
        let anyVisibilityChanged = false;
        for (const art of dirtyArticles) {
          if (!art.isConnected) continue;
          const res = processArticle(art, { forceReprocess: false, allowAsyncAi: true, pageCtx });
          if (res?.changedVisibility) anyVisibilityChanged = true;
        }
        if (pageCtx.newlyFoundFocal) {
          scanTweets(true);
        } else if (anyVisibilityChanged && getFocalTweetId()) {
          updateHiddenStreakIndicators();
        }
      } else if (hasExternal && (!localRulesReady || (getFocalTweetId() && !cachedFocalArticleEl))) {
        scheduleScan();
      }
    });
    observer.observe(document.documentElement || document, { childList: true, subtree: true });

    window.__antislopCleanup = () => {
      observer.disconnect();
      if (bodyThemeObserver) {
        bodyThemeObserver.disconnect();
        bodyThemeObserver = null;
      }
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (scanTimer) {
        clearTimeout(scanTimer);
        scanTimer = null;
      }
      if (localInterceptTimer) {
        clearTimeout(localInterceptTimer);
        localInterceptTimer = null;
      }
      if (activeToastTimer) {
        clearTimeout(activeToastTimer);
        activeToastTimer = null;
      }
      for (const cleanupFn of Array.from(activeStabilizeCleanups)) {
        try {
          cleanupFn();
        } catch {
          // ignore
        }
      }
      activeStabilizeCleanups.clear();
      pendingQueue.clear();
      localInterceptQueue.clear();
      document.removeEventListener('DOMContentLoaded', onDocContentLoaded);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKeydown);
      window.removeEventListener('scroll', onWinScroll);
      if (typeof chrome !== 'undefined') {
        chrome.runtime?.onMessage?.removeListener(onRuntimeMsg);
        chrome.storage?.onChanged?.removeListener(onStorageChange);
      }
      document.querySelectorAll(ARTICLE_SELECTOR).forEach(restoreArticle);
      document
        .querySelectorAll('.antislop-floating-menu, .antislop-toast, .antislop-streak-bar, .antislop-report-wrap, .antislop-eat-stage')
        .forEach((n) => n.remove());
      activeFloatingMenuAnchor = null;
      activeFloatingMenuKey = null;
      lastSyncedBadgeCount = -1;
      lastThemeAttr = '';
      cachedFocalPost = null;
      cachedFocalArticleEl = null;
      cachedDiscoverMoreEl = null;
    };

    const localPromise = hydrateFromLocalStorage();
    const snapshotPromise = hydrateFromSnapshot();

    const hadLocalStorage = await localPromise;
    if (hadLocalStorage && localRulesReady) {
      scanTweets(true);
      syncBadgeCount();
    }

    await snapshotPromise;
    if (currentSettings.enabled) {
      scanTweets(hadLocalStorage ? { reapplyOnly: true } : true);
    } else {
      scanTweets(true);
    }
    syncBadgeCount();
  }

  init();
})();

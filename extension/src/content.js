(function () {
  if (typeof window.__antislopCleanup === 'function') {
    try {
      window.__antislopCleanup();
    } catch {
      // ignore stale cleanup failure
    }
  }

  const { extractTweetData, isDiscoverMoreHeadingText, normalizeDisplayMode, normalizeHandle, sendMessage, el } =
    window.AntiSlopShared;

  const ARTICLE_SELECTOR = 'article[data-testid="tweet"], article[role="article"]';
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

  let currentSettings = { enabled: true, displayMode: 'hide' };
  const processedArticles = new WeakMap();
  const eatingControllers = new WeakMap();
  const userExpandedTweetIds = new Set();
  const streakRevealedTweetIds = new Set();
  const pageFilteredTweetIds = new Set();

  let pendingQueue = new Map();
  let flushTimer = null;
  let scanTimer = null;
  let activeToastTimer = null;
  let lastPathname = window.location.pathname;
  let lastSyncedBadgeCount = -1;
  let activeFloatingMenuKey = null;
  let activeFloatingMenuAnchor = null;
  let cachedFocalPost = null;

  function isDecisionAllowed(result) {
    return !result || result.verdict === 'ALLOW';
  }

  function detectTheme() {
    try {
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
    document.documentElement.setAttribute('data-antislop-theme', detectTheme());
  }

  function detectSelfHandle() {
    const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (switcher) {
      for (const sp of switcher.querySelectorAll('span')) {
        const txt = (sp.textContent || '').trim();
        if (txt.startsWith('@') && txt.length > 1 && txt.length <= 32) return normalizeHandle(txt);
      }
    }
    const profileLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    const m = (profileLink?.getAttribute?.('href') || '').match(/^\/([A-Za-z0-9_]{1,30})\/?$/);
    return m ? normalizeHandle(m[1]) : '';
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

  function cancelEatingAnimation(articleEl) {
    if (!articleEl) return;
    const ctrl = eatingControllers.get(articleEl);
    if (ctrl) {
      ctrl.cancelled = true;
      for (const timerId of ctrl.timers) clearTimeout(timerId);
      eatingControllers.delete(articleEl);
    }
    articleEl.classList.remove('antislop-eating-collapsing');
    articleEl.style.maxHeight = '';
    articleEl.style.opacity = '';
    articleEl.style.transition = '';
    if (articleEl.getAttribute('data-antislop-state') === 'eating') {
      articleEl.removeAttribute('data-antislop-state');
    }
    articleEl.querySelectorAll(':scope > .antislop-eat-stage').forEach((n) => n.remove());
  }

  function restoreArticle(articleEl) {
    cancelEatingAnimation(articleEl);
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

    document.body.appendChild(menu);

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

    document.body.appendChild(toast);
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
        });
      }
    });
    syncBadgeCount();
    updateHiddenStreakIndicators();
  }

  async function triggerWhitelistRecovery(targetHandle, tweetId, itemSnapshot) {
    const normTarget = normalizeHandle(targetHandle);
    if (!normTarget) return;
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
          scanTweets(true);
        },
      },
    ]);
    await actionPromise;
  }

  async function triggerAllowSingleTweet(articleEl, item) {
    if (!item?.tweetId) return;
    restoreSingleArticle(articleEl, item, 'allowed_tweet');
    const actionPromise = sendMessage({
      type: 'ALLOW_TWEET',
      payload: { tweetId: item.tweetId, itemSnapshot: item },
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
          scanTweets(true);
        },
      },
    ]);
    await actionPromise;
  }

  async function triggerUnblockAccount(targetHandle, tweetId) {
    const normTarget = normalizeHandle(targetHandle);
    if (!normTarget) return;
    restoreMatchingArticles(normTarget, 'undo');
    await sendMessage({ type: 'UNBLOCK_ACCOUNT', payload: { handle: normTarget, tweetId } });
  }

  async function triggerUnblockTweet(articleEl, item) {
    if (!item?.tweetId) return;
    restoreSingleArticle(articleEl, item, 'undo');
    await sendMessage({ type: 'UNBLOCK_TWEET', payload: { tweetId: item.tweetId } });
  }

  async function eatSingleTweetWithAnimation(articleEl, latest) {
    if (!currentSettings.enabled || !latest || !articleEl || eatingControllers.has(articleEl)) return;
    closeFloatingMenu();
    if (latest.tweetId) {
      userExpandedTweetIds.delete(latest.tweetId);
      pageFilteredTweetIds.add(latest.tweetId);
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
      },
    });

    const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    const willHide = shouldCompletelyHide(latest, decision);
    if (reducedMotion || !willHide || !ASSET_URLS.eatSprite || !articleEl.isConnected) {
      applyDecision(articleEl, latest, decision, fp);
      updateHiddenStreakIndicators();
      await reportPromise;
      return;
    }

    const beforeRect = articleEl.getBoundingClientRect();
    const startH = Math.max(48, Math.round(beforeRect.height));
    const shouldCompensate = window.scrollY > 80 && beforeRect.height > 60 && beforeRect.bottom > 0 && beforeRect.top < 120;

    processedArticles.set(articleEl, { fingerprint: fp, item: latest, result: decision });
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
      applyDecision(articleEl, latest, decision, fp);
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

    const matchedTweetIds = [];
    const seenIds = new Set();
    const track = (tItem) => {
      if (!tItem?.tweetId) return;
      userExpandedTweetIds.delete(tItem.tweetId);
      streakRevealedTweetIds.delete(tItem.tweetId);
      if (!seenIds.has(tItem.tweetId)) {
        seenIds.add(tItem.tweetId);
        matchedTweetIds.push(tItem.tweetId);
      }
    };

    if (curItem && itemMatchesHandle(curItem, normTarget)) track(curItem);
    document.querySelectorAll(ARTICLE_SELECTOR).forEach((node) => {
      const meta = processedArticles.get(node);
      const elItem = meta?.item || extractTweetData(node);
      if (elItem && itemMatchesHandle(elItem, normTarget)) {
        track(elItem);
        applyDecision(
          node,
          elItem,
          { verdict: 'SLOP', scope: 'ACCOUNT', matchedHandle: normTarget, source: 'user_block' },
          meta?.fingerprint
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
            onClick: () => triggerWhitelistRecovery(targetHandle, item?.tweetId || null, item),
          });
        }
        if (opts.length === 1) opts[0].onClick();
        else if (opts.length > 1) openFloatingMenu(notSlopBtn, opts, `fp_${item?.tweetId || targetHandle}`);
      },
    });

    return [notSlopBtn];
  }

  function renderExpandedArticle(articleEl, item, result, fingerprint) {
    restoreArticle(articleEl);
    articleEl.setAttribute('data-antislop-state', 'expanded');

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
            applyDecision(articleEl, item, result, fingerprint);
          },
        }),
        ...createRecoveryButtons(articleEl, item, result, targetHandle),
      ]
    );
    anchor.appendChild(wrap);
  }

  function renderMaskedArticle(articleEl, item, result, fingerprint) {
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
      renderExpandedArticle(articleEl, item, result, fingerprint);
    };

    const overlay = el(
      'div',
      { className: 'antislop-mask-overlay', attrs: { 'data-antislop-ui': '1' }, onClick: expandArticle },
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

  function applyDecision(articleEl, item, result, fingerprint) {
    const fp = fingerprint || computeFingerprint(item);
    processedArticles.set(articleEl, { fingerprint: fp, item, result });

    if (!currentSettings.enabled || isDecisionAllowed(result)) {
      if (item?.tweetId) {
        pageFilteredTweetIds.delete(item.tweetId);
        syncBadgeCount();
      }
      restoreArticle(articleEl);
      ensureReportButton(articleEl, item);
      return;
    }

    if (item?.tweetId) {
      pageFilteredTweetIds.add(item.tweetId);
      syncBadgeCount();
    }

    if (userExpandedTweetIds.has(item.tweetId)) {
      renderExpandedArticle(articleEl, item, result, fp);
      return;
    }

    const prevState = articleEl.getAttribute('data-antislop-state');
    const shouldCompensate = (!prevState || prevState === 'expanded') && window.scrollY > 80 && articleEl.isConnected;
    const beforeRect = shouldCompensate ? articleEl.getBoundingClientRect() : null;

    if (shouldCompletelyHide(item, result)) {
      restoreArticle(articleEl);
      articleEl.setAttribute('data-antislop-state', 'hidden');
    } else {
      renderMaskedArticle(articleEl, item, result, fp);
    }

    if (beforeRect && beforeRect.height > 60 && beforeRect.bottom > 0 && beforeRect.top < 120) {
      const delta = articleEl.getBoundingClientRect().height - beforeRect.height;
      if (delta < -10) window.scrollBy(0, delta);
    }
  }

  function updateHiddenStreakIndicators() {
    document.querySelectorAll('.antislop-streak-bar').forEach((n) => n.remove());
    if (!currentSettings.enabled || !getFocalTweetId()) return;

    let streak = [];
    const flushStreak = () => {
      if (streak.length < 5) {
        streak = [];
        return;
      }
      const run = streak.slice();
      streak = [];
      const lastCell = run[run.length - 1].cell;
      const bar = el('div', { className: 'antislop-streak-bar', attrs: { 'data-antislop-ui': '1' } }, [
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
                applyDecision(entry.article, meta.item, meta.result, meta.fingerprint);
              }
            }
            updateHiddenStreakIndicators();
          },
        }),
      ]);
      lastCell.insertBefore(bar, lastCell.firstChild);
    };

    for (const cell of document.querySelectorAll('[data-testid="cellInnerDiv"]')) {
      const hidden = cell.querySelector('article[data-antislop-state="hidden"]');
      const visible = cell.querySelector('article:not([data-antislop-state="hidden"])');
      if (hidden && !visible) streak.push({ cell, article: hidden });
      else flushStreak();
    }
    flushStreak();
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

    const existing = articleEl.querySelector('.antislop-report-wrap');
    if (existing) {
      if (existing.hasAttribute('data-antislop-expanded-controls')) existing.remove();
      else return;
    }

    const actionGroup = articleEl.querySelector('[role="group"]');
    const anchor = actionGroup || articleEl.querySelector('[data-testid="User-Name"]');
    if (!anchor) return;

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

  function cascadeSessionAccountInDom(accountHandle, selfHandle) {
    const norm = normalizeHandle(accountHandle);
    if (!norm || (selfHandle && norm === selfHandle)) return;

    document.querySelectorAll(ARTICLE_SELECTOR).forEach((node) => {
      const meta = processedArticles.get(node);
      if (!meta?.item || !isDecisionAllowed(meta.result)) return;
      if (meta.result?.source === 'whitelist' || meta.result?.source === 'allowed_tweet' || meta.result?.source === 'self') {
        return;
      }
      if (itemMatchesHandle(meta.item, norm)) {
        applyDecision(
          node,
          meta.item,
          {
            verdict: 'SLOP',
            scope: 'ACCOUNT',
            matchedHandle: norm,
            source: 'session_account',
            reason: `Session slop account @${norm}`,
          },
          meta.fingerprint
        );
      }
    });
  }

  async function flushQueue() {
    flushTimer = null;
    if (pendingQueue.size === 0 || !currentSettings.enabled) return;

    const batchEntries = Array.from(pendingQueue.values());
    pendingQueue.clear();
    const resp = await sendMessage({ type: 'CLASSIFY_BATCH', items: batchEntries.map((e) => e.item) });
    const results = Array.isArray(resp?.results) ? resp.results : [];
    const newlyCaughtAccounts = new Set();

    for (const entry of batchEntries) {
      const match = results.find((r) => r.tweetId === entry.item.tweetId) || { verdict: 'ALLOW', scope: 'TWEET' };
      applyDecision(entry.articleEl, entry.item, match, entry.fingerprint);
      if (!isDecisionAllowed(match) && match.scope === 'ACCOUNT' && match.matchedHandle) {
        newlyCaughtAccounts.add(normalizeHandle(match.matchedHandle));
      }
    }

    if (newlyCaughtAccounts.size > 0) {
      const selfHandle = detectSelfHandle();
      for (const acct of newlyCaughtAccounts) {
        cascadeSessionAccountInDom(acct, selfHandle);
      }
    }

    updateHiddenStreakIndicators();
  }

  function scanTweets(forceReprocess = false) {
    syncThemeAttr();
    const curPath = window.location.pathname;
    if (curPath !== lastPathname) {
      lastPathname = curPath;
      cachedFocalPost = null;
      pageFilteredTweetIds.clear();
      streakRevealedTweetIds.clear();
      closeFloatingMenu();
      syncBadgeCount();
    }

    if (!currentSettings.enabled) {
      pendingQueue.clear();
      pageFilteredTweetIds.clear();
      closeFloatingMenu();
      syncBadgeCount();
      document.querySelectorAll('.antislop-report-wrap').forEach((n) => n.remove());
      document.querySelectorAll(ARTICLE_SELECTOR).forEach(restoreArticle);
      updateHiddenStreakIndicators();
      return;
    }

    const selfHandle = detectSelfHandle();
    const focalTweetId = getFocalTweetId();
    if (!focalTweetId) {
      cachedFocalPost = null;
    }

    const articles = Array.from(document.querySelectorAll(ARTICLE_SELECTOR));
    let focalIdx = -1;
    let discoverMoreEl = null;
    if (focalTweetId) {
      for (let i = 0; i < articles.length; i += 1) {
        if (articles[i].querySelector(`a[href*="/status/${focalTweetId}"]`)) {
          const probe = extractTweetData(articles[i]);
          if (probe && String(probe.tweetId) === String(focalTweetId)) {
            focalIdx = i;
            cachedFocalPost = {
              tweetId: focalTweetId,
              handle: probe.handle || '',
              text: (probe.text || '').slice(0, 240),
            };
            break;
          }
        }
      }

      const col = document.querySelector('[data-testid="primaryColumn"]') || document;
      const headingCandidates = col.querySelectorAll('h2, [role="heading"], [data-testid="cellInnerDiv"] span');
      for (const node of headingCandidates) {
        if (node.closest(ARTICLE_SELECTOR)) continue;
        if (isDiscoverMoreHeadingText(node.textContent || '')) {
          discoverMoreEl = node;
          break;
        }
      }
    }

    for (let i = 0; i < articles.length; i += 1) {
      const articleEl = articles[i];
      const inDiscoverMore = Boolean(
        discoverMoreEl &&
          typeof discoverMoreEl.compareDocumentPosition === 'function' &&
          (discoverMoreEl.compareDocumentPosition(articleEl) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
      const afterFocal =
        focalTweetId && !inDiscoverMore
          ? focalIdx >= 0
            ? i > focalIdx
            : Boolean(cachedFocalPost && cachedFocalPost.tweetId === focalTweetId)
          : false;
      const item = extractTweetData(articleEl, focalTweetId ? { focalTweetId, afterFocal } : {});
      if (!item) continue;
      if (selfHandle) item.selfHandle = selfHandle;
      if (item.isReply && !inDiscoverMore && cachedFocalPost && cachedFocalPost.tweetId === focalTweetId) {
        item.parentHandle = cachedFocalPost.handle;
        item.parentText = cachedFocalPost.text;
      }

      if (eatingControllers.has(articleEl)) continue;

      const fingerprint = computeFingerprint(item);
      const existing = processedArticles.get(articleEl);
      if (!forceReprocess && existing && existing.fingerprint === fingerprint) continue;

      if (existing && existing.fingerprint !== fingerprint) {
        restoreArticle(articleEl);
        articleEl.querySelectorAll('.antislop-report-wrap').forEach((n) => n.remove());
      }
      processedArticles.set(articleEl, { fingerprint, item, result: null });
      pendingQueue.set(`${item.tweetId}:${fingerprint}`, { articleEl, item, fingerprint });
    }

    if (pendingQueue.size > 0 && !flushTimer) {
      flushTimer = setTimeout(flushQueue, 180);
    } else if (forceReprocess && pendingQueue.size === 0) {
      syncBadgeCount();
      updateHiddenStreakIndicators();
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanTweets(false);
    }, 250);
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
          renderExpandedArticle(node, item, meta.result, meta.fingerprint);
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
      if (changes.antislop_settings) {
        currentSettings = { ...currentSettings, ...(changes.antislop_settings.newValue || {}) };
        currentSettings.displayMode = normalizeDisplayMode(currentSettings.displayMode);
        lastSyncedBadgeCount = -1;
        scanTweets(true);
        syncBadgeCount();
      } else if (
        changes.antislop_whitelist ||
        changes.antislop_blacklist ||
        changes.antislop_local_blacklist ||
        changes.antislop_blocked_tweets ||
        changes.antislop_allowed_tweets
      ) {
        scanTweets(true);
      }
    };

    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKeydown);
    window.addEventListener('scroll', onWinScroll, { passive: true });
    chrome.runtime?.onMessage?.addListener(onRuntimeMsg);
    chrome.storage?.onChanged?.addListener(onStorageChange);

    const observer = new MutationObserver((mutations) => {
      const hasExternal = mutations.some((m) => {
        if (isOwnUiNode(m.target)) return false;
        const nodes = [...m.addedNodes, ...m.removedNodes];
        return nodes.length === 0 || nodes.some((n) => !isOwnUiNode(n));
      });
      if (hasExternal) scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    window.__antislopCleanup = () => {
      observer.disconnect();
      if (flushTimer) clearTimeout(flushTimer);
      if (scanTimer) clearTimeout(scanTimer);
      if (activeToastTimer) clearTimeout(activeToastTimer);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKeydown);
      window.removeEventListener('scroll', onWinScroll);
      chrome.runtime?.onMessage?.removeListener(onRuntimeMsg);
      chrome.storage?.onChanged?.removeListener(onStorageChange);
      document.querySelectorAll(ARTICLE_SELECTOR).forEach(restoreArticle);
      document
        .querySelectorAll('.antislop-floating-menu, .antislop-toast, .antislop-streak-bar, .antislop-report-wrap, .antislop-eat-stage')
        .forEach((n) => n.remove());
      activeFloatingMenuAnchor = null;
      activeFloatingMenuKey = null;
      lastSyncedBadgeCount = -1;
    };

    const state = await sendMessage({ type: 'GET_STATE' });
    if (state?.settings) {
      currentSettings = { ...state.settings, displayMode: normalizeDisplayMode(state.settings.displayMode) };
    }
    scanTweets(true);
    syncBadgeCount();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

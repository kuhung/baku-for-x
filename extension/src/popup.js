(function () {
  const { sendMessage, el, describeRuntimeStatus, describeInterceptEntry } = window.AntiSlopShared;

  let activeXTabId = null;
  let lastTabSummaryCount = null;
  let lastRenderedState = null;
  const optimisticRemovedKeys = new Set();
  let activeLeaveCount = 0;
  let pendingRefreshAfterAnim = false;
  let toastTimer = null;
  let toastHovered = false;
  let toastVersion = 0;
  let tabRecheckTimer = null;
  let companionPetTimer = null;
  let companionMunchTimer = null;
  let playedInitialMunch = false;

  function entryKey(entry) {
    return String(entry?.tweetId || `acct_${entry?.matchedHandle || entry?.handle || ''}`);
  }

  function openDashboard(hash = '') {
    const baseUrl = chrome.runtime.getURL('src/dashboard.html');
    chrome.tabs.create({ url: hash ? `${baseUrl}#${hash}` : baseUrl });
  }

  function renderStatusPill(settings, stats, effectiveFlywheelUrl) {
    const pill = document.getElementById('serverStatusPill');
    const text = document.getElementById('serverStatusText');
    const status = describeRuntimeStatus(settings, stats, effectiveFlywheelUrl);

    pill.classList.remove('is-ok', 'is-err', 'is-muted');
    if (!status.visible) {
      pill.style.display = 'none';
      text.textContent = '';
      return;
    }

    pill.style.display = '';
    pill.classList.add(`is-${status.tone}`);
    pill.title = `${status.detail}（点击打开云端与模型设置）`;
    text.textContent = status.text;
  }

  async function findTargetXTab() {
    if (!chrome.tabs?.query) return null;
    const queryTabs = (q) => new Promise((resolve) => chrome.tabs.query(q, (tabs) => resolve(tabs || [])));
    const isX = (u = '') => u.startsWith('https://x.com/') || u.startsWith('https://twitter.com/');

    const active = (await queryTabs({ active: true, currentWindow: true }))[0];
    if (active?.id != null && isX(active.url)) return active;

    const xTabs = await queryTabs({ url: ['https://x.com/*', 'https://twitter.com/*'], currentWindow: true });
    return xTabs[0] || null;
  }

  async function queryActiveXTab() {
    const tab = await findTargetXTab();
    if (!tab || tab.id == null) return null;
    activeXTabId = tab.id;

    const ask = () =>
      new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: 'GET_TAB_SUMMARY' }, (resp) => {
          resolve(!chrome.runtime.lastError && resp?.ok ? resp : null);
        });
      });

    let summary = await ask();
    if (!summary && chrome.scripting?.executeScript) {
      try {
        if (chrome.scripting.insertCSS) {
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/content.css'] }).catch(() => {});
        }
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/shared.js', 'src/content.js'] });
        await new Promise((r) => setTimeout(r, 120));
        summary = await ask();
      } catch {
        // ignore restricted tab
      }
    }
    return summary || { ok: true, pageFilteredCount: 0 };
  }

  function openTweetFallback(handle, tweetId) {
    if (handle && tweetId && /^\d+$/.test(tweetId)) {
      chrome.tabs.create({ url: `https://x.com/${handle}/status/${tweetId}` });
    } else if (handle) {
      chrome.tabs.create({ url: `https://x.com/${handle}` });
    }
  }

  function peekOrOpenTweet(entry) {
    const info = describeInterceptEntry(entry);
    const tweetId = entry.tweetId ? String(entry.tweetId) : '';
    const handle = info.authorHandle;
    if (activeXTabId && tweetId) {
      chrome.tabs.sendMessage(activeXTabId, { type: 'PEEK_TWEET', tweetId }, (resp) => {
        if (!chrome.runtime.lastError && resp?.found) {
          if (chrome.tabs?.update) {
            chrome.tabs.update(activeXTabId, { active: true }, () => {
              if (typeof window.close === 'function') window.close();
            });
          }
          return;
        }
        openTweetFallback(handle, tweetId);
      });
      return;
    }
    openTweetFallback(handle, tweetId);
  }

  function truncatePreview(rawText, maxUnits = 68) {
    const clean = String(rawText || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    let units = 0;
    let out = '';
    for (const ch of clean) {
      const code = ch.codePointAt(0) || 0;
      const w = code > 0x7f ? 2 : 1;
      if (units + w > maxUnits - 1) return `${out}…`;
      units += w;
      out += ch;
    }
    return clean;
  }

  function hideToast() {
    toastVersion += 1;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toastHovered = false;
    const toastEl = document.getElementById('popupToast');
    if (toastEl) {
      toastEl.hidden = true;
      toastEl.innerHTML = '';
    }
  }

  function scheduleToastAutoHide(version, delayMs) {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (version === toastVersion && !toastHovered) {
        hideToast();
      }
    }, delayMs);
  }

  function showPopupToast(message, undoFn) {
    const toastEl = document.getElementById('popupToast');
    if (!toastEl) return;
    toastVersion += 1;
    const version = toastVersion;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toastHovered = false;
    toastEl.innerHTML = '';

    const actions = [];
    if (typeof undoFn === 'function') {
      const undoBtn = el('button', {
        type: 'button',
        className: 'toast-undo-btn',
        text: '撤销',
        onClick: async () => {
          if (toastTimer) clearTimeout(toastTimer);
          undoBtn.disabled = true;
          undoBtn.textContent = '撤销中…';
          try {
            await undoFn();
          } finally {
            hideToast();
            if (activeLeaveCount === 0) await refresh();
            else pendingRefreshAfterAnim = true;
            scheduleTabCountRecheck();
          }
        },
      });
      actions.push(undoBtn);
    }
    actions.push(
      el('button', {
        type: 'button',
        className: 'toast-close-btn',
        text: '×',
        attrs: { 'aria-label': '关闭提示' },
        onClick: () => hideToast(),
      })
    );

    toastEl.appendChild(el('span', { className: 'toast-text', text: message }));
    toastEl.appendChild(el('div', { className: 'toast-actions' }, actions));
    toastEl.hidden = false;

    toastEl.onmouseenter = () => {
      if (version !== toastVersion) return;
      toastHovered = true;
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
    };
    toastEl.onmouseleave = () => {
      if (version !== toastVersion) return;
      toastHovered = false;
      scheduleToastAutoHide(version, 2500);
    };
    scheduleToastAutoHide(version, 4000);
  }

  async function animateRowsOut(rowEls) {
    const validRows = (rowEls || []).filter((r) => r && r.isConnected);
    if (validRows.length === 0) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;

    activeLeaveCount += 1;
    try {
      for (const row of validRows) {
        row.style.maxHeight = `${row.offsetHeight}px`;
      }
      void validRows[0].offsetHeight;
      for (const row of validRows) {
        row.classList.add('is-leaving');
      }
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      activeLeaveCount = Math.max(0, activeLeaveCount - 1);
    }
  }

  async function refreshTabCountOnly() {
    if (!lastRenderedState?.settings?.enabled) return;
    const summary = await queryActiveXTab();
    if (summary && typeof summary.pageFilteredCount === 'number') {
      lastTabSummaryCount = summary.pageFilteredCount;
      const pageEl = document.getElementById('pageCountVal');
      if (pageEl) pageEl.textContent = String(lastTabSummaryCount);
    }
  }

  function scheduleTabCountRecheck() {
    if (tabRecheckTimer) clearTimeout(tabRecheckTimer);
    tabRecheckTimer = setTimeout(() => {
      tabRecheckTimer = null;
      refreshTabCountOnly();
    }, 280);
  }

  function collectAccountKeys(targetHandle, primaryKey) {
    const keys = new Set([primaryKey]);
    const list = lastRenderedState?.recentIntercepted || [];
    for (const item of list) {
      if (!item) continue;
      const itemInfo = describeInterceptEntry(item);
      if (itemInfo.matchedHandle === targetHandle || itemInfo.authorHandle === targetHandle) {
        keys.add(entryKey(item));
      }
    }
    return Array.from(keys);
  }

  function collectVisibleRowsForKeys(container, keys, targetHandle) {
    const keySet = new Set(keys);
    return Array.from(container.querySelectorAll('.recent-item')).filter(
      (row) => keySet.has(row.dataset.entryKey) || (targetHandle && row.dataset.targetHandle === targetHandle)
    );
  }

  async function runRowRemoval({ container, removedKeys, targetHandle, rowEl, toastText, actionPromise, onUndo }) {
    const affectedRows = targetHandle
      ? collectVisibleRowsForKeys(container, removedKeys, targetHandle)
      : [rowEl].filter(Boolean);
    for (const row of affectedRows) {
      row.querySelectorAll('button').forEach((b) => {
        b.disabled = true;
      });
    }
    for (const k of removedKeys) optimisticRemovedKeys.add(k);

    let undone = false;
    showPopupToast(toastText, async () => {
      undone = true;
      const res = await actionPromise;
      await onUndo(res);
      for (const k of removedKeys) optimisticRemovedKeys.delete(k);
    });

    await animateRowsOut(affectedRows);
    if (activeLeaveCount === 0 && lastRenderedState) {
      renderRecentIntercepted(lastRenderedState.recentIntercepted, lastRenderedState.settings);
      if (pendingRefreshAfterAnim && !undone) {
        pendingRefreshAfterAnim = false;
        refresh();
      }
    }

    try {
      await actionPromise;
    } finally {
      for (const k of removedKeys) optimisticRemovedKeys.delete(k);
      if (!undone) {
        if (activeLeaveCount > 0) pendingRefreshAfterAnim = true;
        else await refresh();
        scheduleTabCountRecheck();
      }
    }
  }

  function renderRecentIntercepted(recentIntercepted, settings) {
    const container = document.getElementById('recentList');
    const allItems = Array.isArray(recentIntercepted) ? recentIntercepted : [];
    const remaining = allItems.filter((it) => it && !optimisticRemovedKeys.has(entryKey(it)));
    const visible = remaining.slice(0, 3);

    document.getElementById('recentCount').textContent = remaining.length > 0 ? `(${remaining.length})` : '';
    const viewAllBtn = document.getElementById('viewAllRecentBtn');
    if (viewAllBtn) {
      viewAllBtn.style.display = remaining.length > 0 ? '' : 'none';
    }

    container.innerHTML = '';

    if (visible.length === 0) {
      const emptyMsg = settings?.enabled
        ? '暂无拦截记录。打开 X 浏览即可自动静默过滤；把扩展图标固定到工具栏，左上角会直接浮现星光计数，悬停或打开弹窗可查看详情。'
        : '过滤已暂停，开启上方开关即可继续过滤 X 时间线与评论区。';
      container.appendChild(el('div', { className: 'recent-empty', text: emptyMsg }));
      return;
    }

    for (const entry of visible) {
      const key = entryKey(entry);
      const info = describeInterceptEntry(entry);
      const tweetId = String(entry.tweetId || '');
      const targetHandle = info.matchedHandle;
      const previewText = truncatePreview(entry.text || entry.quotedText || '');

      const tweetUrl =
        info.authorHandle && tweetId && /^\d+$/.test(tweetId)
          ? `https://x.com/${info.authorHandle}/status/${tweetId}`
          : info.authorHandle
            ? `https://x.com/${info.authorHandle}`
            : '#';
      const openOrig = (e) => {
        e.preventDefault();
        peekOrOpenTweet(entry);
      };

      let rowNode = null;
      const actionButtons = [];
      if (info.isSingleUserBlock) {
        actionButtons.push(
          el('button', {
            type: 'button',
            className: 'mini-btn',
            text: '恢复',
            attrs: { 'aria-label': '恢复此条推文' },
            onClick: () => {
              const actionPromise = sendMessage({ type: 'UNBLOCK_TWEET', payload: { tweetId } });
              runRowRemoval({
                container,
                removedKeys: [key],
                targetHandle: '',
                rowEl: rowNode,
                toastText: '已恢复此条推文',
                actionPromise,
                onUndo: () =>
                  sendMessage({
                    type: 'REPORT_SLOP',
                    payload: {
                      handle: info.authorHandle,
                      displayName: entry.displayName || '',
                      tweetId,
                      scope: 'tweet',
                      text: entry.text || '',
                      quotedHandle: entry.quotedHandle || '',
                      quotedText: entry.quotedText || '',
                    },
                  }),
              });
            },
          })
        );
      } else if (info.isManualAccountBlock && targetHandle) {
        actionButtons.push(
          el('button', {
            type: 'button',
            className: 'mini-btn',
            text: '撤销拉黑',
            attrs: { 'aria-label': `撤销拉黑 @${targetHandle}` },
            onClick: () => {
              const actionPromise = sendMessage({
                type: 'UNBLOCK_ACCOUNT',
                payload: { handle: targetHandle, tweetId: tweetId || null },
              });
              runRowRemoval({
                container,
                removedKeys: collectAccountKeys(targetHandle, key),
                targetHandle,
                rowEl: rowNode,
                toastText: `已撤销拉黑 @${targetHandle}`,
                actionPromise,
                onUndo: () =>
                  sendMessage({
                    type: 'REPORT_SLOP',
                    payload: {
                      handle: targetHandle,
                      displayName: entry.displayName || '',
                      tweetId: tweetId || null,
                      scope: 'account',
                      text: entry.text || '',
                      quotedHandle: entry.quotedHandle || '',
                      quotedText: entry.quotedText || '',
                    },
                  }),
              });
            },
          })
        );
      } else if (info.isAccountOnly) {
        if (targetHandle) {
          actionButtons.push(
            el('button', {
              type: 'button',
              className: 'mini-btn',
              text: '信任账号',
              attrs: { 'aria-label': `信任 @${targetHandle}，加入白名单` },
              onClick: () => {
                const actionPromise = sendMessage({
                  type: 'WHITELIST_ACCOUNT',
                  payload: { handle: targetHandle, tweetId: null, itemSnapshot: entry },
                });
                runRowRemoval({
                  container,
                  removedKeys: collectAccountKeys(targetHandle, key),
                  targetHandle,
                  rowEl: rowNode,
                  toastText: `已信任 @${targetHandle}`,
                  actionPromise,
                  onUndo: (res) =>
                    sendMessage({
                      type: 'UNDO_WHITELIST_ACCOUNT',
                      payload: {
                        handle: targetHandle,
                        wasLocalBlacklisted: Boolean(res?.wasLocalBlacklisted),
                        wasRemoteBlacklisted: Boolean(res?.wasRemoteBlacklisted),
                        entrySnapshots: res?.removedEntries?.length ? res.removedEntries : [entry],
                      },
                    }),
                });
              },
            })
          );
        }
      } else {
        if (tweetId) {
          actionButtons.push(
            el('button', {
              type: 'button',
              className: 'mini-btn',
              text: '放行',
              attrs: { 'aria-label': '仅放行这一条推文' },
              onClick: () => {
                const actionPromise = sendMessage({
                  type: 'ALLOW_TWEET',
                  payload: { tweetId, itemSnapshot: entry },
                });
                runRowRemoval({
                  container,
                  removedKeys: [key],
                  targetHandle: '',
                  rowEl: rowNode,
                  toastText: info.authorHandle ? `已放行 @${info.authorHandle} 此条` : '已放行此条推文',
                  actionPromise,
                  onUndo: (res) =>
                    sendMessage({
                      type: 'UNDO_ALLOW_TWEET',
                      payload: { tweetId, entrySnapshot: res?.removedEntry || entry },
                    }),
                });
              },
            })
          );
        }
        if (targetHandle) {
          actionButtons.push(
            el('button', {
              type: 'button',
              className: 'mini-btn',
              text: '信任',
              attrs: { 'aria-label': `信任 @${targetHandle}，加入白名单` },
              onClick: () => {
                const actionPromise = sendMessage({
                  type: 'WHITELIST_ACCOUNT',
                  payload: { handle: targetHandle, tweetId, itemSnapshot: entry },
                });
                runRowRemoval({
                  container,
                  removedKeys: collectAccountKeys(targetHandle, key),
                  targetHandle,
                  rowEl: rowNode,
                  toastText: `已信任 @${targetHandle}`,
                  actionPromise,
                  onUndo: (res) =>
                    sendMessage({
                      type: 'UNDO_WHITELIST_ACCOUNT',
                      payload: {
                        handle: targetHandle,
                        wasLocalBlacklisted: Boolean(res?.wasLocalBlacklisted),
                        wasRemoteBlacklisted: Boolean(res?.wasRemoteBlacklisted),
                        entrySnapshots: res?.removedEntries?.length ? res.removedEntries : [entry],
                      },
                    }),
                });
              },
            })
          );
        }
      }

      rowNode = el(
        'div',
        {
          className: 'recent-item',
          attrs: {
            'data-entry-key': key,
            ...(targetHandle ? { 'data-target-handle': targetHandle } : {}),
          },
        },
        [
          el('div', { className: 'recent-row-head' }, [
            el(
              'a',
              {
                className: 'recent-author-link',
                href: tweetUrl,
                onClick: openOrig,
              },
              [
                el('span', { className: 'recent-handle', text: info.authorHandle ? `@${info.authorHandle}` : '推文' }),
                el('span', { className: 'reason-tag', text: info.badge }),
              ]
            ),
            el('div', { className: 'recent-actions' }, actionButtons),
          ]),
          previewText
            ? el('p', {
                className: 'recent-preview',
                text: previewText,
                onClick: openOrig,
              })
            : null,
        ]
      );
      container.appendChild(rowNode);
    }
  }

  function updateCompanionState(settings, pageCount) {
    const btn = document.getElementById('bakuCompanionBtn');
    const img = document.getElementById('bakuCompanionImg');
    if (!btn || !img) return;

    const enabled = settings?.enabled !== false;
    btn.classList.toggle('is-paused', !enabled);

    if (!enabled) {
      if (companionMunchTimer) {
        clearTimeout(companionMunchTimer);
        companionMunchTimer = null;
      }
      img.src = '../assets/baku-trigger-idle.png';
      btn.title = '静貘打盹中，开启右上角开关唤醒';
      return;
    }

    const num = typeof pageCount === 'number' ? pageCount : 0;
    btn.title = num > 0 ? `本页已吞掉 ${num} 条（点我摸一摸）` : '静默守候中（点我摸一摸）';

    if (num > 0 && !playedInitialMunch) {
      playedInitialMunch = true;
      img.src = '../assets/baku-toast-munch.webp';
      if (companionMunchTimer) clearTimeout(companionMunchTimer);
      companionMunchTimer = setTimeout(() => {
        companionMunchTimer = null;
        if (lastRenderedState?.settings?.enabled !== false) {
          img.src = '../assets/baku-popup-idle.webp';
        }
      }, 1800);
    } else if (!companionMunchTimer) {
      img.src = '../assets/baku-popup-idle.webp';
    }
  }

  function triggerCompanionPet() {
    const btn = document.getElementById('bakuCompanionBtn');
    if (!btn) return;
    if (lastRenderedState?.settings?.enabled === false) {
      showPopupToast('静貘正在打盹，开启右上角开关唤醒它');
      return;
    }
    if (companionPetTimer) clearTimeout(companionPetTimer);
    btn.classList.remove('is-petting');
    void btn.offsetWidth;
    btn.classList.add('is-petting');
    companionPetTimer = setTimeout(() => {
      companionPetTimer = null;
      btn.classList.remove('is-petting');
    }, 620);
  }

  async function refresh() {
    if (activeLeaveCount > 0) {
      pendingRefreshAfterAnim = true;
      return;
    }
    const [state, tabSummary] = await Promise.all([
      sendMessage({ type: 'GET_STATE' }),
      queryActiveXTab(),
    ]);
    if (!state) {
      const container = document.getElementById('recentList');
      container.innerHTML = '';
      container.appendChild(
        el('div', { className: 'recent-empty recent-empty-err', text: '扩展后台暂未响应，请刷新 X 页面或重新打开弹窗。' })
      );
      return;
    }

    lastRenderedState = state;
    if (activeLeaveCount > 0) {
      pendingRefreshAfterAnim = true;
      return;
    }
    const { settings, effectiveFlywheelUrl, recentIntercepted = [], stats } = state;

    document.getElementById('enabledToggle').checked = Boolean(settings.enabled);
    renderStatusPill(settings, stats, effectiveFlywheelUrl);

    if (tabSummary && typeof tabSummary.pageFilteredCount === 'number') {
      lastTabSummaryCount = tabSummary.pageFilteredCount;
    }
    const pageEl = document.getElementById('pageCountVal');
    pageEl.textContent = settings.enabled
      ? (lastTabSummaryCount !== null ? String(lastTabSummaryCount) : '-')
      : '0';
    document.getElementById('totalCountVal').textContent = String(stats?.filteredCount || 0);
    updateCompanionState(settings, lastTabSummaryCount);

    renderRecentIntercepted(recentIntercepted, settings);
  }

  document.addEventListener('DOMContentLoaded', () => {
    refresh();
    document.getElementById('enabledToggle').addEventListener('change', async (e) => {
      await sendMessage({ type: 'UPDATE_SETTINGS', settings: { enabled: e.target.checked } });
      refresh();
    });
    document.getElementById('bakuCompanionBtn')?.addEventListener('click', triggerCompanionPet);
    document.getElementById('serverStatusPill').addEventListener('click', () => openDashboard('cloud'));
    document.getElementById('viewAllRecentBtn').addEventListener('click', () => openDashboard('feedback'));
    document.getElementById('openDashboardBtn').addEventListener('click', () => openDashboard());

    chrome.storage?.onChanged?.addListener((_changes, areaName) => {
      if (areaName === 'local') refresh();
    });
  });
})();

(function () {
  const {
    sendMessage,
    el,
    DEFAULT_FLYWHEEL_URL,
    DEFAULT_AI_BASE_URL,
    DEFAULT_AI_MODEL,
    describeRuntimeStatus,
    describeInterceptEntry,
    normalizeDisplayMode,
    normalizeBadgeMode,
    normalizeAiScanScope,
  } = window.AntiSlopShared;

  const AUDIT_PAGE_SIZE = 20;
  const ACCOUNTS_PAGE_SIZE = 50;

  let dashData = null;
  let currentTab = 'feedback';
  let currentAccountTab = 'effective';
  let auditPage = 1;
  let accountPage = 1;
  let cloudFieldsInitialized = false;
  let isSavingFlywheel = false;
  let accountMsgTimer = null;
  const optimisticRemovedAuditKeys = new Set();
  const optimisticRemovedAccountKeys = new Set();
  let activeLeaveCount = 0;
  let pendingRefreshAfterAnim = false;
  let dashToastTimer = null;
  let dashToastHovered = false;
  let dashToastVersion = 0;

  const auditEntryKey = (entry) => String(entry?.tweetId || `acct_${entry?.matchedHandle || entry?.handle || ''}`);
  const accountRowKey = (tab, handle) => `${tab}:${handle}`;

  const normalizeHandleInput = (raw) => String(raw || '').trim().replace(/^@+/, '').toLowerCase();

  function formatTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function showMsg(elId, text, tone = '', undoFn = null) {
    const node = document.getElementById(elId);
    if (!node) return;
    if (elId === 'accountActionMsg' && accountMsgTimer) {
      clearTimeout(accountMsgTimer);
      accountMsgTimer = null;
    }
    node.innerHTML = '';
    node.className = tone ? `feedback-banner ${tone}` : 'feedback-banner';
    if (!text) {
      node.style.display = 'none';
      return;
    }
    node.appendChild(el('span', { text }));
    if (typeof undoFn === 'function') {
      node.appendChild(
        el('button', {
          type: 'button',
          className: 'btn btn-sm',
          text: '撤销',
          onClick: async () => {
            if (accountMsgTimer) clearTimeout(accountMsgTimer);
            node.style.display = 'none';
            await undoFn();
            refresh();
          },
        })
      );
      if (elId === 'accountActionMsg') {
        accountMsgTimer = setTimeout(() => {
          node.style.display = 'none';
        }, 5000);
      }
    }
    node.style.display = 'flex';
  }

  function switchTab(rawTabName) {
    currentTab = ['feedback', 'accounts', 'cloud'].includes(rawTabName) ? rawTabName : 'feedback';
    document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === currentTab));
    document.querySelectorAll('.section').forEach((sec) => sec.classList.toggle('active', sec.id === `tab-${currentTab}`));
    if (window.location.hash !== `#${currentTab}`) history.replaceState(null, '', `#${currentTab}`);
  }

  function renderTopbar() {
    if (!dashData) return;
    const { settings, effectiveFlywheelUrl, stats, blacklistCount = 0 } = dashData;

    document.getElementById('topbarSummary').textContent = `累计拦截 ${stats?.filteredCount || 0} 条`;

    const statusBtn = document.getElementById('topbarStatusBtn');
    const statusText = document.getElementById('topbarStatusText');
    const status = describeRuntimeStatus(settings, stats, effectiveFlywheelUrl);
    statusBtn.classList.remove('is-ok', 'is-err', 'is-muted');
    if (status.visible) {
      statusBtn.style.display = '';
      statusBtn.classList.add(`is-${status.tone}`);
      statusBtn.title = `${status.detail}（点击跳转云端与模型设置）`;
      statusText.textContent = status.text;
    } else {
      statusBtn.style.display = 'none';
      statusText.textContent = '';
    }

    document.getElementById('navAccountsBadge').textContent = String(blacklistCount);
    document.getElementById('dashEnabledToggle').checked = Boolean(settings.enabled);
  }

  function hideDashToast() {
    dashToastVersion += 1;
    if (dashToastTimer) {
      clearTimeout(dashToastTimer);
      dashToastTimer = null;
    }
    dashToastHovered = false;
    const toastEl = document.getElementById('dashToast');
    if (toastEl) {
      toastEl.hidden = true;
      toastEl.innerHTML = '';
    }
  }

  function scheduleDashToastAutoHide(version, delayMs) {
    if (dashToastTimer) clearTimeout(dashToastTimer);
    dashToastTimer = setTimeout(() => {
      if (version === dashToastVersion && !dashToastHovered) {
        hideDashToast();
      }
    }, delayMs);
  }

  function showDashToast(message, undoFn = null) {
    const toastEl = document.getElementById('dashToast');
    if (!toastEl) return;
    dashToastVersion += 1;
    const version = dashToastVersion;
    if (dashToastTimer) {
      clearTimeout(dashToastTimer);
      dashToastTimer = null;
    }
    dashToastHovered = false;
    toastEl.innerHTML = '';

    const actions = [];
    if (typeof undoFn === 'function') {
      const undoBtn = el('button', {
        type: 'button',
        className: 'toast-undo-btn',
        text: '撤销',
        onClick: async () => {
          if (dashToastTimer) clearTimeout(dashToastTimer);
          undoBtn.disabled = true;
          undoBtn.textContent = '撤销中…';
          try {
            await undoFn();
          } finally {
            hideDashToast();
            if (activeLeaveCount === 0) await refresh();
            else pendingRefreshAfterAnim = true;
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
        onClick: () => hideDashToast(),
      })
    );

    toastEl.appendChild(el('span', { className: 'toast-text', text: message }));
    toastEl.appendChild(el('div', { className: 'toast-actions' }, actions));
    toastEl.hidden = false;

    toastEl.onmouseenter = () => {
      if (version !== dashToastVersion) return;
      dashToastHovered = true;
      if (dashToastTimer) {
        clearTimeout(dashToastTimer);
        dashToastTimer = null;
      }
    };
    toastEl.onmouseleave = () => {
      if (version !== dashToastVersion) return;
      dashToastHovered = false;
      scheduleDashToastAutoHide(version, 2500);
    };
    scheduleDashToastAutoHide(version, 4500);
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

  function renderPagination(containerEl, { page, pageSize, totalItems, unitLabel, scrollTargetEl, onPageChange }) {
    if (!containerEl) return 1;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    containerEl.innerHTML = '';

    if (totalItems === 0 || totalPages <= 1) {
      containerEl.style.display = 'none';
      return safePage;
    }

    const start = (safePage - 1) * pageSize + 1;
    const end = Math.min(totalItems, safePage * pageSize);

    const goPage = (nextPage) => {
      onPageChange(nextPage);
      if (scrollTargetEl && scrollTargetEl.getBoundingClientRect().top < 0) {
        scrollTargetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };

    containerEl.appendChild(
      el('span', { className: 'pagination-info', text: `第 ${start}–${end} ${unitLabel}，共 ${totalItems} ${unitLabel}` })
    );
    containerEl.appendChild(
      el('div', { className: 'pagination-controls' }, [
        el('button', {
          type: 'button',
          className: 'btn btn-sm',
          text: '上一页',
          attrs: safePage <= 1 ? { disabled: 'disabled' } : {},
          onClick: () => goPage(safePage - 1),
        }),
        el('span', { className: 'pagination-page', text: `${safePage} / ${totalPages}` }),
        el('button', {
          type: 'button',
          className: 'btn btn-sm',
          text: '下一页',
          attrs: safePage >= totalPages ? { disabled: 'disabled' } : {},
          onClick: () => goPage(safePage + 1),
        }),
      ])
    );
    containerEl.style.display = '';
    return safePage;
  }

  function collectAuditAccountKeys(targetHandle, primaryKey, list) {
    const keys = new Set([primaryKey]);
    for (const item of list || []) {
      if (!item) continue;
      const info = describeInterceptEntry(item);
      if (info.matchedHandle === targetHandle || info.authorHandle === targetHandle) {
        keys.add(auditEntryKey(item));
      }
    }
    return Array.from(keys);
  }

  async function runAuditRemoval({ container, removedKeys, targetHandle, rowEl, toastText, actionPromise, onUndo }) {
    const keySet = new Set(removedKeys);
    const affectedRows = targetHandle
      ? Array.from(container.querySelectorAll('.audit-row')).filter(
          (row) => keySet.has(row.dataset.entryKey) || row.dataset.targetHandle === targetHandle
        )
      : [rowEl].filter(Boolean);

    for (const row of affectedRows) {
      row.querySelectorAll('button').forEach((b) => {
        b.disabled = true;
      });
    }
    for (const k of removedKeys) optimisticRemovedAuditKeys.add(k);

    let undone = false;
    showDashToast(toastText, async () => {
      undone = true;
      const res = await actionPromise;
      await onUndo(res);
      for (const k of removedKeys) optimisticRemovedAuditKeys.delete(k);
    });

    await animateRowsOut(affectedRows);
    if (activeLeaveCount === 0) {
      renderRecentSection();
      if (pendingRefreshAfterAnim && !undone) {
        pendingRefreshAfterAnim = false;
        refresh();
      }
    }

    try {
      await actionPromise;
    } finally {
      for (const k of removedKeys) optimisticRemovedAuditKeys.delete(k);
      if (!undone) {
        if (activeLeaveCount > 0) pendingRefreshAfterAnim = true;
        else await refresh();
      }
    }
  }

  function renderRecentSection() {
    if (!dashData) return;
    const { recentIntercepted = [], localBlacklist = [], settings, stats } = dashData;
    const q = (document.getElementById('auditSearchInput').value || '').trim().toLowerCase();

    const available = recentIntercepted.filter(
      (entry) => entry && !optimisticRemovedAuditKeys.has(auditEntryKey(entry))
    );
    const filtered = available.filter((entry) => {
      if (!q) return true;
      const hay = [entry.handle, entry.matchedHandle, entry.displayName, entry.text, entry.quotedText].join('\n').toLowerCase();
      return hay.includes(q);
    });

    const metaEl = document.getElementById('auditListMeta');
    if (metaEl) {
      const baseTotal = available.length;
      const totalFiltered = Number(stats?.filteredCount || 0);
      if (q) {
        metaEl.textContent = `匹配 ${filtered.length} / ${baseTotal} 条`;
      } else if (totalFiltered > baseTotal && baseTotal > 0) {
        metaEl.textContent = `保留最近 ${baseTotal} 条（累计 ${totalFiltered} 条）`;
      } else if (baseTotal > 0) {
        metaEl.textContent = `共 ${baseTotal} 条`;
      } else {
        metaEl.textContent = '';
      }
    }

    const totalPages = Math.max(1, Math.ceil(filtered.length / AUDIT_PAGE_SIZE));
    auditPage = Math.min(Math.max(1, auditPage), totalPages);
    const startIdx = (auditPage - 1) * AUDIT_PAGE_SIZE;
    const pageItems = filtered.slice(startIdx, startIdx + AUDIT_PAGE_SIZE);

    const container = document.getElementById('auditList');
    const paginationEl = document.getElementById('auditPagination');
    container.innerHTML = '';

    if (filtered.length === 0) {
      if (paginationEl) {
        paginationEl.style.display = 'none';
        paginationEl.innerHTML = '';
      }
      const emptyText = q
        ? '没有找到匹配的拦截记录。'
        : settings?.enabled
          ? '暂无拦截记录。打开 X 浏览即可自动静默过滤；把扩展图标固定到工具栏，左上角会直接浮现星光计数，悬停或打开弹窗可查看详情。'
          : '过滤已暂停，开启右上角开关后即可在 X 网页端自动过滤 Slop。';
      container.appendChild(el('div', { className: 'empty-state', text: emptyText }));
      return;
    }

    const localBlSet = new Set(localBlacklist);
    for (const entry of pageItems) {
      const key = auditEntryKey(entry);
      const info = describeInterceptEntry(entry);
      const primaryHandle = info.authorHandle;
      const targetHandle = info.matchedHandle;

      const headTags = [
        primaryHandle
          ? el('a', {
              className: 'handle-link',
              href: `https://x.com/${primaryHandle}`,
              target: '_blank',
              rel: 'noopener noreferrer',
              text: `@${primaryHandle}`,
            })
          : el('span', { className: 'handle-link', text: '未知账号' }),
        el('span', { className: 'tag', text: info.badge }),
      ];

      let rowNode = null;
      const actionButtons = [];
      if (info.isSingleUserBlock && entry.tweetId) {
        actionButtons.push(
          el('button', {
            type: 'button',
            className: 'btn btn-sm',
            text: '恢复',
            onClick: () => {
              const actionPromise = sendMessage({ type: 'UNBLOCK_TWEET', payload: { tweetId: entry.tweetId } });
              runAuditRemoval({
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
                      handle: primaryHandle,
                      displayName: entry.displayName || '',
                      tweetId: entry.tweetId,
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
            className: 'btn btn-sm',
            text: `撤销拉黑 @${targetHandle}`,
            onClick: () => {
              const actionPromise = sendMessage({
                type: 'UNBLOCK_ACCOUNT',
                payload: { handle: targetHandle, tweetId: entry.tweetId || null },
              });
              runAuditRemoval({
                container,
                removedKeys: collectAuditAccountKeys(targetHandle, key, available),
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
                      tweetId: entry.tweetId || null,
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
              className: 'btn btn-sm',
              text: `信任 @${targetHandle}`,
              onClick: () => {
                const actionPromise = sendMessage({
                  type: 'WHITELIST_ACCOUNT',
                  payload: { handle: targetHandle, tweetId: null, itemSnapshot: entry },
                });
                runAuditRemoval({
                  container,
                  removedKeys: collectAuditAccountKeys(targetHandle, key, available),
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
        if (entry.tweetId) {
          actionButtons.push(
            el('button', {
              type: 'button',
              className: 'btn btn-sm',
              text: '放行此条',
              onClick: () => {
                const actionPromise = sendMessage({
                  type: 'ALLOW_TWEET',
                  payload: { tweetId: entry.tweetId, itemSnapshot: entry },
                });
                runAuditRemoval({
                  container,
                  removedKeys: [key],
                  targetHandle: '',
                  rowEl: rowNode,
                  toastText: primaryHandle ? `已放行 @${primaryHandle} 此条` : '已放行此条推文',
                  actionPromise,
                  onUndo: (res) =>
                    sendMessage({
                      type: 'UNDO_ALLOW_TWEET',
                      payload: { tweetId: entry.tweetId, entrySnapshot: res?.removedEntry || entry },
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
              className: 'btn btn-sm',
              text: `信任 @${targetHandle}`,
              onClick: () => {
                const actionPromise = sendMessage({
                  type: 'WHITELIST_ACCOUNT',
                  payload: { handle: targetHandle, tweetId: entry.tweetId, itemSnapshot: entry },
                });
                runAuditRemoval({
                  container,
                  removedKeys: collectAuditAccountKeys(targetHandle, key, available),
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
        if (targetHandle && !localBlSet.has(targetHandle)) {
          actionButtons.push(
            el('button', {
              type: 'button',
              className: 'btn btn-sm btn-danger',
              text: `拉黑 @${targetHandle}`,
              onClick: async (e) => {
                const btnEl = e.currentTarget;
                if (btnEl) btnEl.disabled = true;
                const actionPromise = sendMessage({
                  type: 'REPORT_SLOP',
                  payload: {
                    handle: targetHandle,
                    displayName: entry.displayName || '',
                    tweetId: entry.tweetId,
                    scope: 'account',
                    text: entry.text || '',
                    quotedHandle: entry.quotedHandle || '',
                    quotedText: entry.quotedText || '',
                  },
                });
                let undone = false;
                showDashToast(`已拉黑 @${targetHandle}`, async () => {
                  undone = true;
                  await actionPromise;
                  await sendMessage({ type: 'UNBLOCK_ACCOUNT', payload: { handle: targetHandle, tweetId: entry.tweetId } });
                });
                try {
                  await actionPromise;
                } finally {
                  if (!undone) {
                    if (activeLeaveCount > 0) pendingRefreshAfterAnim = true;
                    else await refresh();
                  }
                }
              },
            })
          );
        }
      }

      rowNode = el(
        'article',
        {
          className: 'audit-row',
          attrs: {
            'data-entry-key': key,
            ...(targetHandle ? { 'data-target-handle': targetHandle } : {}),
          },
        },
        [
          el('div', { className: 'audit-head' }, [
            el('div', { className: 'audit-identity' }, headTags),
            el('div', { className: 'audit-identity' }, [
              entry.tweetId && /^\d+$/.test(String(entry.tweetId)) && primaryHandle
                ? el('a', {
                    href: `https://x.com/${primaryHandle}/status/${entry.tweetId}`,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    text: '查看原推',
                  })
                : null,
              el('span', { className: 'audit-time', text: formatTime(entry.interceptedAt) }),
            ]),
          ]),
          entry.text ? el('div', { className: 'audit-text', text: entry.text }) : null,
          entry.quotedText || entry.quotedHandle
            ? el('div', {
                className: 'audit-quote',
                text: `引用${entry.quotedHandle ? ` @${entry.quotedHandle}` : ''}：${entry.quotedText || '(无正文)'}`,
              })
            : null,
          el('div', { className: 'audit-foot' }, [el('div', { className: 'audit-actions' }, actionButtons)]),
        ]
      );
      container.appendChild(rowNode);
    }

    renderPagination(paginationEl, {
      page: auditPage,
      pageSize: AUDIT_PAGE_SIZE,
      totalItems: filtered.length,
      unitLabel: '条',
      scrollTargetEl: document.querySelector('#tab-feedback .page-head'),
      onPageChange: (next) => {
        auditPage = next;
        renderRecentSection();
      },
    });
  }

  async function runAccountRemoval({ rKey, rowEl, toastText, actionPromise, onUndo }) {
    if (rowEl) {
      rowEl.querySelectorAll('button').forEach((b) => {
        b.disabled = true;
      });
    }
    optimisticRemovedAccountKeys.add(rKey);

    let undone = false;
    showDashToast(toastText, async () => {
      undone = true;
      const res = await actionPromise;
      await onUndo(res);
      optimisticRemovedAccountKeys.delete(rKey);
    });

    await animateRowsOut([rowEl]);
    if (activeLeaveCount === 0) {
      renderAccountsSection();
      if (pendingRefreshAfterAnim && !undone) {
        pendingRefreshAfterAnim = false;
        refresh();
      }
    }

    try {
      await actionPromise;
    } finally {
      optimisticRemovedAccountKeys.delete(rKey);
      if (!undone) {
        if (activeLeaveCount > 0) pendingRefreshAfterAnim = true;
        else await refresh();
      }
    }
  }

  function renderAccountsSection() {
    if (!dashData) return;
    const {
      effectiveFlywheelUrl,
      effectiveBlacklist = [],
      localBlacklist = [],
      remoteBlacklist = [],
      whitelist = [],
      accountInterceptCounts = {},
    } = dashData;

    const showSubSplits = Boolean(effectiveFlywheelUrl) || remoteBlacklist.length > 0;
    if (!showSubSplits && (currentAccountTab === 'local' || currentAccountTab === 'remote')) {
      currentAccountTab = 'effective';
    }

    document.getElementById('cntEffective').textContent = String(effectiveBlacklist.length);
    document.getElementById('cntLocal').textContent = String(localBlacklist.length);
    document.getElementById('cntRemote').textContent = String(remoteBlacklist.length);
    document.getElementById('cntWhitelist').textContent = String(whitelist.length);

    document.querySelectorAll('#accountSubTabs .sub-tab').forEach((btn) => {
      const tabKey = btn.dataset.acctTab;
      if (tabKey === 'local' || tabKey === 'remote') {
        btn.style.display = showSubSplits ? '' : 'none';
      }
      btn.classList.toggle('active', tabKey === currentAccountTab);
    });

    const localSet = new Set(localBlacklist);
    const remoteSet = new Set(remoteBlacklist);
    const wlSet = new Set(whitelist);
    const sourceMap = {
      effective: effectiveBlacklist,
      local: localBlacklist,
      remote: remoteBlacklist,
      whitelist,
    };
    const q = normalizeHandleInput(document.getElementById('accountSearchInput').value);
    const rawList = sourceMap[currentAccountTab] || [];
    const available = rawList.filter((h) => !optimisticRemovedAccountKeys.has(accountRowKey(currentAccountTab, h)));
    const filtered = available.filter((h) => !q || h.includes(q));

    const totalPages = Math.max(1, Math.ceil(filtered.length / ACCOUNTS_PAGE_SIZE));
    accountPage = Math.min(Math.max(1, accountPage), totalPages);
    const startIdx = (accountPage - 1) * ACCOUNTS_PAGE_SIZE;
    const pageItems = filtered.slice(startIdx, startIdx + ACCOUNTS_PAGE_SIZE);

    const listEl = document.getElementById('accountsList');
    const paginationEl = document.getElementById('accountsPagination');
    listEl.innerHTML = '';

    if (filtered.length === 0) {
      if (paginationEl) {
        paginationEl.style.display = 'none';
        paginationEl.innerHTML = '';
      }
      listEl.appendChild(el('div', { className: 'empty-state', text: q ? `没有找到匹配 “${q}” 的账号` : '当前分类下暂无账号' }));
      return;
    }

    for (const handle of pageItems) {
      const rKey = accountRowKey(currentAccountTab, handle);
      const hitCount = accountInterceptCounts[handle] || 0;
      const originText = wlSet.has(handle)
        ? '信任白名单'
        : localSet.has(handle) && remoteSet.has(handle)
          ? '本地与云端'
          : localSet.has(handle)
            ? '本地拉黑'
            : '云端黑名单';

      let rowNode = null;
      const btns = [];
      if (currentAccountTab === 'whitelist' || wlSet.has(handle)) {
        btns.push(
          el('button', {
            type: 'button',
            className: 'btn btn-sm',
            text: '移出白名单',
            onClick: () => {
              const actionPromise = sendMessage({ type: 'REMOVE_WHITELIST', handle });
              runAccountRemoval({
                rKey,
                rowEl: rowNode,
                toastText: `已将 @${handle} 移出信任白名单`,
                actionPromise,
                onUndo: () => sendMessage({ type: 'WHITELIST_ACCOUNT', payload: { handle } }),
              });
            },
          })
        );
      } else {
        if (localSet.has(handle)) {
          btns.push(
            el('button', {
              type: 'button',
              className: 'btn btn-sm',
              text: '移出黑名单',
              onClick: () => {
                const actionPromise = sendMessage({ type: 'UNBLOCK_ACCOUNT', payload: { handle } });
                runAccountRemoval({
                  rKey,
                  rowEl: rowNode,
                  toastText: `已将 @${handle} 移出黑名单`,
                  actionPromise,
                  onUndo: () => sendMessage({ type: 'REPORT_SLOP', payload: { handle, scope: 'account' } }),
                });
              },
            })
          );
        }
        if (remoteSet.has(handle)) {
          btns.push(
            el('button', {
              type: 'button',
              className: 'btn btn-sm',
              text: `信任 @${handle}`,
              onClick: () => {
                const actionPromise = sendMessage({ type: 'WHITELIST_ACCOUNT', payload: { handle } });
                runAccountRemoval({
                  rKey,
                  rowEl: rowNode,
                  toastText: `已将 @${handle} 加入信任白名单`,
                  actionPromise,
                  onUndo: (res) =>
                    sendMessage({
                      type: 'UNDO_WHITELIST_ACCOUNT',
                      payload: {
                        handle,
                        wasLocalBlacklisted: Boolean(res?.wasLocalBlacklisted),
                        wasRemoteBlacklisted: Boolean(res?.wasRemoteBlacklisted),
                        entrySnapshots: res?.removedEntries || [],
                      },
                    }),
                });
              },
            })
          );
        }
      }

      rowNode = el('div', { className: 'acct-row', attrs: { 'data-account-handle': handle } }, [
        el('div', { className: 'acct-left' }, [
          el('a', {
            className: 'handle-link',
            href: `https://x.com/${handle}`,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: `@${handle}`,
          }),
          showSubSplits || wlSet.has(handle)
            ? el('span', { className: wlSet.has(handle) ? 'tag ok' : 'tag', text: originText })
            : null,
          !wlSet.has(handle) ? el('span', { className: 'tag', text: `已拦 ${hitCount} 条` }) : null,
        ]),
        el('div', { className: 'audit-actions' }, btns),
      ]);
      listEl.appendChild(rowNode);
    }

    renderPagination(paginationEl, {
      page: accountPage,
      pageSize: ACCOUNTS_PAGE_SIZE,
      totalItems: filtered.length,
      unitLabel: '个',
      scrollTargetEl: document.getElementById('accountSubTabs'),
      onPageChange: (next) => {
        accountPage = next;
        renderAccountsSection();
      },
    });
  }

  function renderCloudSection() {
    if (!dashData) return;
    const { settings, effectiveFlywheelUrl, stats, remoteBlacklist = [] } = dashData;

    const modeSelect = document.getElementById('displayModeSelect');
    const badgeModeSelect = document.getElementById('badgeModeSelect');
    const scopeSelect = document.getElementById('scanScopeSelect');
    if (modeSelect && document.activeElement !== modeSelect) {
      modeSelect.value = normalizeDisplayMode(settings.displayMode);
    }
    if (badgeModeSelect && document.activeElement !== badgeModeSelect) {
      badgeModeSelect.value = normalizeBadgeMode(settings.badgeMode);
    }
    if (scopeSelect && document.activeElement !== scopeSelect) {
      scopeSelect.value = normalizeAiScanScope(settings.aiScanScope);
    }

    if (!cloudFieldsInitialized) {
      document.getElementById('flywheelEnabledToggle').checked = Boolean(settings.flywheelEnabled);
      document.getElementById('flywheelUrlInput').value = settings.flywheelUrl || '';
      document.getElementById('flywheelTokenInput').value = settings.flywheelToken || '';

      document.getElementById('aiEnabledToggle').checked = Boolean(settings.aiEnabled);
      document.getElementById('aiApiKeyInput').value = settings.aiApiKey || '';
      document.getElementById('aiBaseUrlInput').value =
        settings.aiBaseUrl && settings.aiBaseUrl !== DEFAULT_AI_BASE_URL ? settings.aiBaseUrl : '';
      document.getElementById('aiModelInput').value =
        settings.aiModel && settings.aiModel !== DEFAULT_AI_MODEL ? settings.aiModel : '';
      cloudFieldsInitialized = true;
    }

    const syncBtn = document.getElementById('syncNowBtn');
    const flywheelChecked = document.getElementById('flywheelEnabledToggle').checked;
    const hasAddress = Boolean(effectiveFlywheelUrl || document.getElementById('flywheelUrlInput').value.trim() || DEFAULT_FLYWHEEL_URL);
    syncBtn.style.display = flywheelChecked && hasAddress ? '' : 'none';

    const diagWrap = document.getElementById('flywheelDiagWrap');
    const grid = document.getElementById('flywheelDiagGrid');
    const endpointEl = document.getElementById('flywheelDiagEndpoint');
    grid.innerHTML = '';

    if (!settings.flywheelEnabled || !effectiveFlywheelUrl) {
      diagWrap.style.display = 'none';
      endpointEl.textContent = '';
      return;
    }

    diagWrap.style.display = '';
    const statusText = stats?.backendOnline
      ? '在线'
      : !stats?.lastSyncAt && !stats?.lastError
        ? '同步中'
        : `连接异常${stats?.lastError ? ` (${stats.lastError})` : ''}`;

    const items = [
      { k: '连接状态', v: statusText },
      { k: '云端账号黑名单', v: String(remoteBlacklist.length) },
      { k: '云端已缓存垃圾帖', v: String(stats?.remoteSlopPostCount ?? 0) },
      { k: '最近同步时间', v: formatTime(stats?.lastSyncAt) },
    ];
    for (const item of items) {
      grid.appendChild(
        el('div', { className: 'diag-well' }, [
          el('div', { className: 'diag-k', text: item.k }),
          el('div', { className: 'diag-v', text: item.v }),
        ])
      );
    }
    endpointEl.textContent = `当前服务地址：${effectiveFlywheelUrl}`;
  }

  async function ensureHostPermission(rawUrl, msgElId) {
    if (!rawUrl) return true;
    try {
      const parsed = new URL(rawUrl);
      if (['127.0.0.1', 'localhost'].includes(parsed.hostname)) return true;
      if (!chrome.permissions?.request) return true;
      const granted = await chrome.permissions.request({ origins: [`${parsed.origin}/*`] });
      if (!granted) {
        showMsg(msgElId, `未授予扩展访问 ${parsed.origin} 的网络权限`, 'err');
        return false;
      }
      return true;
    } catch {
      showMsg(msgElId, '地址格式无效，请填写完整 http(s):// 地址', 'err');
      return false;
    }
  }

  async function refresh() {
    if (activeLeaveCount > 0) {
      pendingRefreshAfterAnim = true;
      return;
    }
    const data = await sendMessage({ type: 'GET_DASHBOARD_DATA' });
    if (!data) {
      const auditEl = document.getElementById('auditList');
      const acctEl = document.getElementById('accountsList');
      if (auditEl) {
        auditEl.innerHTML = '';
        auditEl.appendChild(el('div', { className: 'empty-state empty-state-err', text: '无法连接到扩展后台，请刷新页面后重试。' }));
      }
      if (acctEl) {
        acctEl.innerHTML = '';
        acctEl.appendChild(el('div', { className: 'empty-state empty-state-err', text: '无法连接到扩展后台，请刷新页面后重试。' }));
      }
      return;
    }
    if (activeLeaveCount > 0) {
      pendingRefreshAfterAnim = true;
      return;
    }
    dashData = data;
    renderTopbar();
    renderRecentSection();
    renderAccountsSection();
    renderCloudSection();
  }

  document.addEventListener('DOMContentLoaded', () => {
    switchTab((window.location.hash || '').replace(/^#/, '') || 'feedback');
    refresh();

    document.querySelectorAll('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
    document.getElementById('topbarStatusBtn').addEventListener('click', () => switchTab('cloud'));
    window.addEventListener('hashchange', () => {
      const h = (window.location.hash || '').replace(/^#/, '');
      if (h) switchTab(h);
    });

    document.getElementById('dashEnabledToggle').addEventListener('change', async (e) => {
      await sendMessage({ type: 'UPDATE_SETTINGS', settings: { enabled: e.target.checked } });
      refresh();
    });

    document.getElementById('auditSearchInput').addEventListener('input', () => {
      auditPage = 1;
      renderRecentSection();
    });

    document.querySelectorAll('#accountSubTabs .sub-tab').forEach((btn) =>
      btn.addEventListener('click', () => {
        currentAccountTab = btn.dataset.acctTab;
        accountPage = 1;
        renderAccountsSection();
      })
    );
    document.getElementById('accountSearchInput').addEventListener('input', () => {
      accountPage = 1;
      renderAccountsSection();
    });

    document.getElementById('manualBlockBtn').addEventListener('click', async () => {
      const input = document.getElementById('manualAccountInput');
      const handle = normalizeHandleInput(input.value);
      if (!handle) return;
      showMsg('accountActionMsg', '');
      input.value = '';
      const actionPromise = sendMessage({ type: 'REPORT_SLOP', payload: { handle, scope: 'account' } });
      showDashToast(`已将 @${handle} 加入黑名单`, async () => {
        await actionPromise;
        await sendMessage({ type: 'UNBLOCK_ACCOUNT', payload: { handle } });
      });
      await actionPromise;
      refresh();
    });

    document.getElementById('manualWhitelistBtn').addEventListener('click', async () => {
      const input = document.getElementById('manualAccountInput');
      const handle = normalizeHandleInput(input.value);
      if (!handle) return;
      showMsg('accountActionMsg', '');
      input.value = '';
      const actionPromise = sendMessage({ type: 'WHITELIST_ACCOUNT', payload: { handle } });
      showDashToast(`已将 @${handle} 加入信任白名单`, async () => {
        const res = await actionPromise;
        await sendMessage({
          type: 'UNDO_WHITELIST_ACCOUNT',
          payload: {
            handle,
            wasLocalBlacklisted: Boolean(res?.wasLocalBlacklisted),
            wasRemoteBlacklisted: Boolean(res?.wasRemoteBlacklisted),
            entrySnapshots: res?.removedEntries || [],
          },
        });
      });
      await actionPromise;
      refresh();
    });

    document.getElementById('exportDataBtn').addEventListener('click', () => {
      if (!dashData) return;
      const payload = {
        exportedAt: new Date().toISOString(),
        localBlacklist: dashData.localBlacklist || [],
        whitelist: dashData.whitelist || [],
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      el('a', { href: url, download: `baku-lists-${new Date().toISOString().slice(0, 10)}.json` }).click();
      URL.revokeObjectURL(url);
      showMsg('accountActionMsg', '已导出账号黑白名单 JSON', 'ok');
    });

    document.getElementById('importDataBtn').addEventListener('click', () => document.getElementById('importFileInput').click());
    document.getElementById('importFileInput').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const res = await sendMessage({ type: 'IMPORT_USER_DATA', payload: { data: JSON.parse(await file.text()) } });
        if (res?.ok) {
          showMsg('accountActionMsg', `导入成功：黑名单 ${res.localBlacklistCount} 个，白名单 ${res.whitelistCount} 个`, 'ok');
          refresh();
        } else {
          showMsg('accountActionMsg', res?.error || '导入失败', 'err');
        }
      } catch (err) {
        showMsg('accountActionMsg', `JSON 解析失败：${err.message}`, 'err');
      } finally {
        e.target.value = '';
      }
    });

    document.getElementById('displayModeSelect').addEventListener('change', async (e) => {
      const displayMode = normalizeDisplayMode(e.target.value);
      await sendMessage({ type: 'UPDATE_SETTINGS', settings: { displayMode } });
      showMsg(
        'prefMsg',
        displayMode === 'mask' ? '已切换为毛玻璃遮罩' : '已切换为无痕隐藏（默认）',
        'ok'
      );
      refresh();
    });

    document.getElementById('badgeModeSelect').addEventListener('change', async (e) => {
      const badgeMode = normalizeBadgeMode(e.target.value);
      await sendMessage({ type: 'UPDATE_SETTINGS', settings: { badgeMode } });
      const msgMap = {
        corner: '已切换为左上星光计数（默认）',
        count: '已切换为原生右下数字角标',
        none: '已切换为纯静默图标（仅弹窗与悬停显示计数）',
      };
      showMsg('prefMsg', msgMap[badgeMode], 'ok');
      refresh();
    });

    document.getElementById('scanScopeSelect').addEventListener('change', async (e) => {
      const aiScanScope = normalizeAiScanScope(e.target.value);
      await sendMessage({ type: 'UPDATE_SETTINGS', settings: { aiScanScope } });
      showMsg(
        'prefMsg',
        aiScanScope === 'all' ? '已切换为扫描全部时间线与评论区' : '已切换为仅扫描评论区与引用',
        'ok'
      );
      refresh();
    });

    document.getElementById('flywheelEnabledToggle').addEventListener('change', renderCloudSection);
    document.getElementById('flywheelUrlInput').addEventListener('input', renderCloudSection);

    document.getElementById('saveFlywheelBtn').addEventListener('click', async () => {
      if (isSavingFlywheel) return;
      const flywheelEnabled = document.getElementById('flywheelEnabledToggle').checked;
      const flywheelUrl = document.getElementById('flywheelUrlInput').value.trim();
      const flywheelToken = document.getElementById('flywheelTokenInput').value.trim();

      const targetCheckUrl = flywheelUrl || DEFAULT_FLYWHEEL_URL;
      if (flywheelEnabled && targetCheckUrl && !(await ensureHostPermission(targetCheckUrl, 'flywheelSaveMsg'))) {
        return;
      }

      const btn = document.getElementById('saveFlywheelBtn');
      isSavingFlywheel = true;
      btn.textContent = '同步中...';
      btn.disabled = true;

      await sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: { flywheelEnabled, flywheelUrl, flywheelToken },
      });
      const syncRes = await sendMessage({ type: 'SYNC_BLACKLIST', full: true });

      isSavingFlywheel = false;
      btn.textContent = '保存并同步';
      btn.disabled = false;

      if (!flywheelEnabled || (!flywheelUrl && !dashData?.effectiveFlywheelUrl && !DEFAULT_FLYWHEEL_URL)) {
        showMsg('flywheelSaveMsg', '已保存：当前仅使用本机黑白名单', 'ok');
      } else if (syncRes?.ok && syncRes.mode === 'remote') {
        showMsg('flywheelSaveMsg', `连接成功，已同步 ${syncRes.count || 0} 个云端黑名单账号`, 'ok');
      } else if (syncRes?.ok) {
        showMsg('flywheelSaveMsg', '已保存：当前保持本机模式', 'ok');
      } else {
        showMsg('flywheelSaveMsg', `设置已保存，但连接失败：${syncRes?.error || '服务不可达'}`, 'err');
      }
      await refresh();
    });

    document.getElementById('syncNowBtn').addEventListener('click', async () => {
      const syncRes = await sendMessage({ type: 'SYNC_BLACKLIST' });
      if (syncRes?.ok && syncRes.mode === 'remote') {
        showMsg('flywheelSaveMsg', `同步完成：云端黑名单共 ${syncRes.count || 0} 个账号`, 'ok');
      } else if (syncRes?.mode === 'local') {
        showMsg('flywheelSaveMsg', '当前未开启云端飞轮', '');
      } else {
        showMsg('flywheelSaveMsg', `同步失败：${syncRes?.error || '服务不可达'}`, 'err');
      }
      await refresh();
    });

    document.getElementById('saveAiBtn').addEventListener('click', async () => {
      const aiEnabled = document.getElementById('aiEnabledToggle').checked;
      const aiApiKey = document.getElementById('aiApiKeyInput').value.trim();
      const aiBaseUrl = document.getElementById('aiBaseUrlInput').value.trim() || DEFAULT_AI_BASE_URL;
      const aiModel = document.getElementById('aiModelInput').value.trim() || DEFAULT_AI_MODEL;

      if (aiEnabled) {
        if (!aiApiKey) {
          return showMsg('aiSaveMsg', '启用浏览器直连模型需要先填写接口密钥', 'err');
        }
        if (!(await ensureHostPermission(aiBaseUrl, 'aiSaveMsg'))) {
          return;
        }
      }

      await sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: { aiEnabled, aiApiKey, aiBaseUrl, aiModel },
      });
      showMsg('aiSaveMsg', aiEnabled ? '已保存：浏览器直连判帖已启用' : '已保存：已关闭浏览器直连判帖', 'ok');
      await refresh();
    });

    chrome.storage?.onChanged?.addListener((_changes, areaName) => {
      if (areaName === 'local') refresh();
    });
  });
})();

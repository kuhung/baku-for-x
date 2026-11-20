import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/shared.js';
import '../src/background.js';

const { DEFAULT_FLYWHEEL_URL } = globalThis.AntiSlopShared;
const { createBackgroundController, STORAGE_KEYS } = globalThis.AntiSlopBackground;

function clone(val) {
  return val === undefined ? undefined : JSON.parse(JSON.stringify(val));
}

function createMockChrome(initial = {}) {
  const store = new Map(Object.entries(clone(initial)));

  return {
    storage: {
      local: {
        async get(keys) {
          await Promise.resolve();
          if (keys == null) {
            return Object.fromEntries(Array.from(store.entries()).map(([k, v]) => [k, clone(v)]));
          }
          const keyList = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
          const out = {};
          for (const k of keyList) {
            if (store.has(k)) out[k] = clone(store.get(k));
          }
          return out;
        },
        async set(obj) {
          await Promise.resolve();
          for (const [k, v] of Object.entries(obj)) {
            store.set(k, clone(v));
          }
        },
      },
    },
    _dump() {
      return Object.fromEntries(Array.from(store.entries()).map(([k, v]) => [k, clone(v)]));
    },
  };
}

test('REPORT_SLOP (account) immediately blocks locally, deduplicates rescan counts, and cleans up on UNBLOCK_ACCOUNT', async () => {
  const chromeApi = createMockChrome();
  const ctrl = createBackgroundController({ chromeApi, defaultFlywheelUrl: '' });

  await ctrl.handleMessage({
    type: 'REPORT_SLOP',
    payload: {
      handle: 'Spam_Bot',
      tweetId: 't1',
      matchedTweetIds: ['t1', 't2'],
      scope: 'account',
      text: 'spam post',
    },
  });

  let state = await ctrl.handleMessage({ type: 'GET_STATE' });
  assert.equal(state.blacklistCount, 1);
  assert.deepEqual(state.localBlacklist, ['spam_bot']);
  assert.equal(state.stats.filteredCount, 2);

  const batchRes = await ctrl.handleMessage({
    type: 'CLASSIFY_BATCH',
    items: [
      { tweetId: 't1', handle: 'spam_bot', text: 'post 1' },
      { tweetId: 't2', handle: 'normal_user', retweeterHandle: 'spam_bot', text: 'post 2' },
    ],
  });
  assert.equal(batchRes.results[0].verdict, 'SLOP');
  assert.equal(batchRes.results[0].scope, 'ACCOUNT');
  assert.equal(batchRes.results[1].verdict, 'SLOP');

  state = await ctrl.handleMessage({ type: 'GET_STATE' });
  assert.equal(state.stats.filteredCount, 2);

  await ctrl.handleMessage({
    type: 'UNBLOCK_ACCOUNT',
    payload: { handle: 'spam_bot', tweetId: 't1' },
  });
  state = await ctrl.handleMessage({ type: 'GET_STATE' });
  assert.equal(state.blacklistCount, 0);
  assert.deepEqual(state.whitelist, []);
  assert.equal(state.recentIntercepted.length, 0);
});

test('BYOK Gemini Decisions classifies grey-area posts as TWEET, caches across rescans, and does not auto-emit BLOCK_ACCOUNT', async () => {
  let aiCalls = 0;
  const signaledPayloads = [];
  const chromeApi = createMockChrome({
    [STORAGE_KEYS.SETTINGS]: {
      enabled: true,
      flywheelEnabled: true,
      flywheelUrl: 'https://flywheel.example.com',
      aiEnabled: true,
      aiApiKey: 'AIza-byok',
      aiScanScope: 'replies',
    },
  });

  const mockFetch = async (url, init) => {
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      aiCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            answers: {
              p_0_slop: { type: 'noul', noul: 0.93, confidence: 0.95 },
            },
          };
        },
      };
    }
    if (url === 'https://flywheel.example.com/api/v1/signal') {
      signaledPayloads.push(JSON.parse(init.body));
      return { ok: true, status: 200, async json() { return { ok: true }; } };
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const ctrl = createBackgroundController({ chromeApi, fetchImpl: mockFetch });

  const res1 = await ctrl.handleMessage({
    type: 'CLASSIFY_BATCH',
    items: [
      {
        tweetId: 'dom_ai_spammer_1a2b3c',
        handle: 'ai_spammer',
        isReply: true,
        text: 'DM me for secret alpha growth strategy right now!',
      },
      {
        tweetId: 'dom_ai_spammer_4d5e6f',
        handle: 'ai_spammer',
        isReply: false,
        text: 'Good morning everyone!',
      },
    ],
  });

  assert.equal(aiCalls, 1);
  assert.equal(res1.results[0].verdict, 'SLOP');
  assert.equal(res1.results[0].scope, 'TWEET');
  assert.equal(res1.results[1].verdict, 'ALLOW');

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(signaledPayloads.length, 0);

  await ctrl.handleMessage({
    type: 'CLASSIFY_BATCH',
    items: [
      {
        tweetId: 'dom_ai_spammer_1a2b3c',
        handle: 'ai_spammer',
        isReply: true,
        text: 'DM me for secret alpha growth strategy right now!',
      },
    ],
  });
  assert.equal(aiCalls, 1);
});

test('Default flywheel URL sends grey-area batches without token, cascades ACCOUNT verdicts, and emits silent user signals', async () => {
  const signalCalls = [];
  const batchCalls = [];
  let syncRound = 0;
  const chromeApi = createMockChrome();

  const mockFetch = async (url, init) => {
    if (url.startsWith(`${DEFAULT_FLYWHEEL_URL}/api/v1/blacklist`)) {
      syncRound += 1;
      if (syncRound === 1) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              version: 10,
              updatedAt: '2026-11-19T00:00:00.000Z',
              incremental: false,
              accounts: [{ handle: 'bot_one' }, { handle: 'false_hit' }],
              removed: [],
            };
          },
        };
      }
      assert.ok(url.includes('sinceVersion=10'));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            version: 12,
            updatedAt: '2026-11-19T00:05:00.000Z',
            incremental: true,
            accounts: [{ handle: 'bot_two' }],
            removed: ['false_hit'],
          };
        },
      };
    }
    if (url === `${DEFAULT_FLYWHEEL_URL}/health`) {
      return { ok: true, status: 200, async json() { return { ok: true, slopPostCount: 7 }; } };
    }
    if (url === `${DEFAULT_FLYWHEEL_URL}/api/v1/classify/batch`) {
      assert.equal(init.headers.Authorization, undefined);
      const body = JSON.parse(init.body);
      batchCalls.push(body);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            results: body.items.map((it) =>
              it.handle === 'escalated_bot'
                ? {
                    tweetId: it.tweetId,
                    handle: it.handle,
                    matchedHandle: 'escalated_bot',
                    verdict: 'SLOP',
                    scope: 'ACCOUNT',
                    source: 'blacklist',
                  }
                : {
                    tweetId: it.tweetId,
                    handle: it.handle,
                    matchedHandle: it.handle,
                    verdict: 'SLOP',
                    scope: 'TWEET',
                    source: 'ai_model',
                  }
            ),
          };
        },
      };
    }
    if (url === `${DEFAULT_FLYWHEEL_URL}/api/v1/signal`) {
      signalCalls.push(JSON.parse(init.body));
      return { ok: true, status: 200, async json() { return { ok: true, blacklisted: false }; } };
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  const ctrl = createBackgroundController({ chromeApi, fetchImpl: mockFetch });

  const s1 = await ctrl.handleMessage({ type: 'SYNC_BLACKLIST' });
  assert.equal(s1.count, 2);
  assert.equal(s1.stats.remoteSlopPostCount, 7);

  const s2 = await ctrl.handleMessage({ type: 'SYNC_BLACKLIST' });
  assert.equal(s2.count, 2);

  // Batch classify defaults to replies-only scope, skips normal timeline posts, routes replies to flywheel without token, and cascades ACCOUNT results
  const batchRes = await ctrl.handleMessage({
    type: 'CLASSIFY_BATCH',
    items: [
      { tweetId: '900000', handle: 'normal_timeline', isReply: false, text: 'Regular timeline post should be skipped under replies scope' },
      { tweetId: '900001', handle: 'escalated_bot', isReply: true, text: 'First reply in thread' },
      { tweetId: '900002', handle: 'single_slop_user', isReply: true, text: 'Comment AI for free guide!' },
    ],
  });
  assert.equal(batchCalls.length, 1);
  assert.equal(batchCalls[0].items.length, 2);
  assert.equal(batchRes.results[0].verdict, 'ALLOW');
  assert.equal(batchRes.results[0].source, 'allow');
  assert.equal(batchRes.results[1].scope, 'ACCOUNT');
  assert.equal(batchRes.results[2].scope, 'TWEET');

  // Subsequent post from escalated_bot hits session_account immediately
  const cachedAcct = await ctrl.handleMessage({
    type: 'CLASSIFY_BATCH',
    items: [{ tweetId: '900003', handle: 'escalated_bot', text: 'Normal text' }],
  });
  assert.equal(batchCalls.length, 1);
  assert.equal(cachedAcct.results[0].source, 'session_account');

  // User actions emit flywheel signals
  await ctrl.handleMessage({
    type: 'REPORT_SLOP',
    payload: { handle: 'missed_bot', tweetId: 'tw1', scope: 'account', text: 'spam' },
  });
  await ctrl.handleMessage({
    type: 'ALLOW_TWEET',
    payload: { tweetId: 'tw2', itemSnapshot: { handle: 'good_guy', text: 'normal tweet' } },
  });
  await ctrl.handleMessage({
    type: 'WHITELIST_ACCOUNT',
    payload: { handle: 'bot_one', tweetId: 'tw3' },
  });

  assert.deepEqual(
    signalCalls.map((c) => c.type),
    ['BLOCK_ACCOUNT', 'APPEAL_TWEET', 'APPEAL_ACCOUNT']
  );

  const dash = await ctrl.handleMessage({ type: 'GET_DASHBOARD_DATA' });
  assert.equal(dash.whitelist.includes('bot_one'), true);
  assert.equal(dash.effectiveBlacklist.includes('bot_one'), false);
});

test('Empty defaultFlywheelUrl runs silently offline with zero network calls and cleanly toggles to remote & back', async () => {
  const fetchCalls = [];
  const alarmCalls = [];
  const chromeApi = {
    ...createMockChrome(),
    alarms: {
      async create(name, info) {
        alarmCalls.push({ op: 'create', name, info });
      },
      async clear(name) {
        alarmCalls.push({ op: 'clear', name });
        return true;
      },
    },
  };
  const mockFetch = async (url) => {
    fetchCalls.push(url);
    if (url.startsWith('https://worker.example.com/api/v1/blacklist')) {
      return { ok: true, status: 200, async json() { return { version: 1, accounts: [{ handle: 'shared_bot' }] }; } };
    }
    if (url === 'https://worker.example.com/health') {
      return { ok: true, status: 200, async json() { return { ok: true }; } };
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  const ctrl = createBackgroundController({ chromeApi, fetchImpl: mockFetch, defaultFlywheelUrl: '' });

  const initial = await ctrl.handleMessage({ type: 'GET_STATE' });
  assert.equal(initial.effectiveFlywheelUrl, '');

  const localSync = await ctrl.handleMessage({ type: 'SYNC_BLACKLIST' });
  assert.equal(localSync.mode, 'local');
  assert.equal(fetchCalls.length, 0);

  await ctrl.handleMessage({
    type: 'UPDATE_SETTINGS',
    settings: { flywheelEnabled: true, flywheelUrl: 'https://worker.example.com/' },
  });
  assert.equal(alarmCalls.some((c) => c.op === 'create' && c.name === 'antislop_sync'), true);

  const remoteSync = await ctrl.handleMessage({ type: 'SYNC_BLACKLIST' });
  assert.equal(remoteSync.ok, true);
  assert.equal(remoteSync.mode, 'remote');
  assert.equal(remoteSync.count, 1);

  await ctrl.handleMessage({ type: 'UPDATE_SETTINGS', settings: { flywheelUrl: '' } });
  const backLocal = await ctrl.handleMessage({ type: 'GET_STATE' });
  assert.equal(backLocal.stats.mode, 'local');
  assert.equal(alarmCalls[alarmCalls.length - 1].op, 'clear');
});

test('UPDATE_BADGE, toolbar three-state icons, IMPORT_USER_DATA, and single-tweet REPORT_SLOP/UNBLOCK_TWEET behave consistently', async () => {
  const actionCalls = [];
  const chromeApi = {
    ...createMockChrome(),
    action: {
      async setIcon(details) {
        actionCalls.push({ fn: 'setIcon', details });
      },
      async setTitle(details) {
        actionCalls.push({ fn: 'setTitle', details });
      },
      async setBadgeText(details) {
        actionCalls.push({ fn: 'setBadgeText', details });
      },
      async setBadgeBackgroundColor(details) {
        actionCalls.push({ fn: 'setBadgeBackgroundColor', details });
      },
      async setBadgeTextColor(details) {
        actionCalls.push({ fn: 'setBadgeTextColor', details });
      },
    },
  };
  const renderCalls = [];
  const ctrl = createBackgroundController({
    chromeApi,
    defaultFlywheelUrl: '',
    renderCornerIcon: async (num) => {
      renderCalls.push(num);
      return { 16: { width: 16, height: 16, mockCount: num }, 32: { width: 32, height: 32, mockCount: num } };
    },
  });

  // Default corner mode: count=120 renders corner imageData + dynamic tooltip, keeps native badge text empty
  const resActive = await ctrl.handleMessage({ type: 'UPDATE_BADGE', count: 120 }, { tab: { id: 5 } });
  assert.equal(resActive.icon, 'active');
  assert.equal(resActive.usedCornerImageData, true);
  assert.equal(resActive.text, '');
  assert.equal(resActive.title, 'Baku · 本页已吞掉 120 条');
  assert.equal(renderCalls[0], 120);
  const lastIconCall = actionCalls.findLast((c) => c.fn === 'setIcon');
  assert.equal(lastIconCall.details.imageData[32].mockCount, 120);
  assert.equal(actionCalls.findLast((c) => c.fn === 'setBadgeText').details.text, '');

  // count=0 reverts to idle icon & standby tooltip
  const resIdle = await ctrl.handleMessage({ type: 'UPDATE_BADGE', count: 0 }, { tab: { id: 6 } });
  assert.equal(resIdle.icon, 'idle');
  assert.equal(resIdle.title, 'Baku · 静默守候中');

  // Switching to count mode immediately updates tracked tabs (tab 5 gets '99+' and idle icon)
  await ctrl.handleMessage({ type: 'UPDATE_SETTINGS', settings: { badgeMode: 'count' } });
  const tab5Badge = actionCalls.findLast((c) => c.fn === 'setBadgeText' && c.details.tabId === 5);
  const tab5Icon = actionCalls.findLast((c) => c.fn === 'setIcon' && c.details.tabId === 5);
  assert.equal(tab5Badge.details.text, '99+');
  assert.equal(tab5Icon.details.path[16], 'icons/icon-idle-16.png');

  // Switching to none mode clears numeric badge while preserving hover tooltip count
  await ctrl.handleMessage({ type: 'UPDATE_SETTINGS', settings: { badgeMode: 'none' } });
  const tab5Cleared = actionCalls.findLast((c) => c.fn === 'setBadgeText' && c.details.tabId === 5);
  const tab5Title = actionCalls.findLast((c) => c.fn === 'setTitle' && c.details.tabId === 5);
  assert.equal(tab5Cleared.details.text, '');
  assert.equal(tab5Title.details.title, 'Baku · 本页已吞掉 120 条');

  // Pausing switches icon to paused, clears badge, and sets paused tooltip
  await ctrl.handleMessage({ type: 'UPDATE_SETTINGS', settings: { enabled: false } });
  const tab5PausedIcon = actionCalls.findLast((c) => c.fn === 'setIcon' && c.details.tabId === 5);
  const tab5PausedTitle = actionCalls.findLast((c) => c.fn === 'setTitle' && c.details.tabId === 5);
  assert.equal(tab5PausedIcon.details.path[16], 'icons/icon-paused-16.png');
  assert.equal(tab5PausedTitle.details.title, 'Baku · 已暂停');

  // Re-enabling restores corner active state for tracked tab 5 (via cached imageData)
  await ctrl.handleMessage({ type: 'UPDATE_SETTINGS', settings: { enabled: true, badgeMode: 'corner' } });
  const tab5ResumedIcon = actionCalls.findLast((c) => c.fn === 'setIcon' && c.details.tabId === 5);
  assert.equal(tab5ResumedIcon.details.imageData[32].mockCount, 120);
  assert.equal(renderCalls.length, 1);

  // Without OffscreenCanvas / renderCornerIcon, corner mode gracefully falls back to static active icon path
  const fallbackCalls = [];
  const ctrlFallback = createBackgroundController({
    chromeApi: {
      ...createMockChrome(),
      action: {
        async setIcon(details) {
          fallbackCalls.push(details);
        },
        async setBadgeText() {},
        async setTitle() {},
      },
    },
    defaultFlywheelUrl: '',
  });
  const fbRes = await ctrlFallback.handleMessage({ type: 'UPDATE_BADGE', count: 5 }, { tab: { id: 9 } });
  assert.equal(fbRes.usedCornerImageData, false);
  assert.equal(fallbackCalls[0].path[16], 'icons/icon-active-16.png');

  await ctrl.handleMessage({
    type: 'REPORT_SLOP',
    payload: { handle: 'u1', tweetId: 'single_1', scope: 'tweet', text: 'annoying' },
  });
  const blockedRes = await ctrl.handleMessage({
    type: 'CLASSIFY_BATCH',
    items: [{ tweetId: 'single_1', handle: 'u1', text: 'annoying' }],
  });
  assert.equal(blockedRes.results[0].verdict, 'SLOP');
  assert.equal(blockedRes.results[0].scope, 'TWEET');

  await ctrl.handleMessage({ type: 'UNBLOCK_TWEET', payload: { tweetId: 'single_1' } });
  const restoredRes = await ctrl.handleMessage({
    type: 'CLASSIFY_BATCH',
    items: [{ tweetId: 'single_1', handle: 'u1', text: 'annoying' }],
  });
  assert.equal(restoredRes.results[0].verdict, 'ALLOW');

  const impRes = await ctrl.handleMessage({
    type: 'IMPORT_USER_DATA',
    payload: { data: { localBlacklist: ['a_bot', 'wl_friend'], whitelist: ['wl_friend'] } },
  });
  assert.equal(impRes.localBlacklistCount, 1);
  assert.equal(impRes.whitelistCount, 1);
});

test('UNDO_ALLOW_TWEET and UNDO_WHITELIST_ACCOUNT restore lists, recent entries, and verdict evaluation cleanly', async () => {
  const chromeApi = createMockChrome({
    [STORAGE_KEYS.LOCAL_BLACKLIST]: ['repeat_bot'],
    [STORAGE_KEYS.REMOTE_BLACKLIST]: ['repeat_bot'],
    [STORAGE_KEYS.RECENT_INTERCEPTED]: [
      {
        tweetId: 't_ai_1',
        handle: 'normal_guy',
        matchedHandle: 'normal_guy',
        text: 'Some borderline reply',
        scope: 'TWEET',
        source: 'ai_model',
        interceptedAt: '2026-11-19T10:00:00.000Z',
      },
      {
        tweetId: 't_bl_2',
        handle: 'repeat_bot',
        matchedHandle: 'repeat_bot',
        text: 'Bot spam post',
        scope: 'ACCOUNT',
        source: 'blacklist',
        interceptedAt: '2026-11-19T10:01:00.000Z',
      },
    ],
  });
  const ctrl = createBackgroundController({ chromeApi, defaultFlywheelUrl: '' });

  // Allow single tweet, then undo it
  const allowRes = await ctrl.handleMessage({
    type: 'ALLOW_TWEET',
    payload: { tweetId: 't_ai_1' },
  });
  assert.equal(allowRes.ok, true);
  assert.equal(allowRes.removedEntry.tweetId, 't_ai_1');

  let allowCheck = await ctrl.handleMessage({
    type: 'CLASSIFY_BATCH',
    items: [{ tweetId: 't_ai_1', handle: 'normal_guy', text: 'Some borderline reply' }],
  });
  assert.equal(allowCheck.results[0].source, 'allowed_tweet');

  await ctrl.handleMessage({
    type: 'UNDO_ALLOW_TWEET',
    payload: { tweetId: 't_ai_1', entrySnapshot: allowRes.removedEntry },
  });
  allowCheck = await ctrl.handleMessage({
    type: 'CLASSIFY_BATCH',
    items: [{ tweetId: 't_ai_1', handle: 'normal_guy', text: 'Some borderline reply' }],
  });
  assert.notEqual(allowCheck.results[0].source, 'allowed_tweet');
  let state = await ctrl.handleMessage({ type: 'GET_STATE' });
  assert.equal(state.recentIntercepted.some((e) => e.tweetId === 't_ai_1'), true);

  // Whitelist blacklisted account, then undo it
  const wlRes = await ctrl.handleMessage({
    type: 'WHITELIST_ACCOUNT',
    payload: { handle: 'repeat_bot', tweetId: 't_bl_2' },
  });
  assert.equal(wlRes.wasLocalBlacklisted, true);
  assert.equal(wlRes.wasRemoteBlacklisted, true);
  assert.equal(wlRes.removedEntries.length, 1);

  let blCheck = await ctrl.handleMessage({
    type: 'CLASSIFY_BATCH',
    items: [{ tweetId: 't_bl_2', handle: 'repeat_bot', text: 'Bot spam post' }],
  });
  assert.equal(blCheck.results[0].verdict, 'ALLOW');
  assert.equal(blCheck.results[0].source, 'whitelist');

  await ctrl.handleMessage({
    type: 'UNDO_WHITELIST_ACCOUNT',
    payload: {
      handle: 'repeat_bot',
      wasLocalBlacklisted: wlRes.wasLocalBlacklisted,
      wasRemoteBlacklisted: wlRes.wasRemoteBlacklisted,
      entrySnapshots: wlRes.removedEntries,
    },
  });

  blCheck = await ctrl.handleMessage({
    type: 'CLASSIFY_BATCH',
    items: [{ tweetId: 't_bl_2', handle: 'repeat_bot', text: 'Bot spam post' }],
  });
  assert.equal(blCheck.results[0].verdict, 'SLOP');
  assert.equal(blCheck.results[0].scope, 'ACCOUNT');

  const dash = await ctrl.handleMessage({ type: 'GET_DASHBOARD_DATA' });
  assert.deepEqual(dash.whitelist, []);
  assert.deepEqual(dash.localBlacklist, ['repeat_bot']);
  assert.deepEqual(dash.remoteBlacklist, ['repeat_bot']);
  assert.equal(dash.recentIntercepted.some((e) => e.tweetId === 't_bl_2'), true);
});

test('MARK_STAGE_SEEN persists lastSeenStageId monotonically, rejects invalid IDs, and handles upgraded existing stats', async () => {
  const chromeApi = createMockChrome({
    [STORAGE_KEYS.STATS]: {
      filteredCount: 640,
      mode: 'remote',
      backendOnline: true,
    },
  });
  const ctrl = createBackgroundController({ chromeApi, defaultFlywheelUrl: '' });

  // Upgrading user starts with empty lastSeenStageId while preserving existing filteredCount
  let state = await ctrl.handleMessage({ type: 'GET_STATE' });
  assert.equal(state.stats.filteredCount, 640);
  assert.equal(state.stats.lastSeenStageId, '');

  // Invalid stageId is rejected cleanly without touching storage
  const badRes = await ctrl.handleMessage({ type: 'MARK_STAGE_SEEN', payload: { stageId: 'nonexistent' } });
  assert.equal(badRes.ok, false);

  // Advances to 'sage'
  const firstSeen = await ctrl.handleMessage({ type: 'MARK_STAGE_SEEN', payload: { stageId: 'sage' } });
  assert.equal(firstSeen.ok, true);
  assert.equal(firstSeen.updated, true);
  assert.equal(firstSeen.lastSeenStageId, 'sage');

  // Cannot regress back to 'fawn' or re-mark 'sage'
  const regressRes = await ctrl.handleMessage({ type: 'MARK_STAGE_SEEN', payload: { stageId: 'fawn' } });
  assert.equal(regressRes.ok, true);
  assert.equal(regressRes.updated, false);
  assert.equal(regressRes.lastSeenStageId, 'sage');

  // Advances from 'sage' to 'astral'
  const maxRes = await ctrl.handleMessage({ type: 'MARK_STAGE_SEEN', payload: { stageId: 'astral' } });
  assert.equal(maxRes.ok, true);
  assert.equal(maxRes.updated, true);
  assert.equal(maxRes.lastSeenStageId, 'astral');

  state = await ctrl.handleMessage({ type: 'GET_STATE' });
  assert.equal(state.stats.lastSeenStageId, 'astral');
  assert.equal(state.stats.filteredCount, 640);
});

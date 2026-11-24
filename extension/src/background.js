if (typeof importScripts === 'function') {
  importScripts('shared.js');
}

(function (rootScope) {
  const {
    DEFAULT_FLYWHEEL_URL,
    normalizeSettings,
    normalizeBadgeMode,
    resolveFlywheelUrl,
    normalizeHandle,
    evaluateLocalRules,
    shouldQueryAiClassifier,
    classifyWithAi,
    paintToolbarCornerCount,
    getBakuStageIndex,
  } = rootScope.AntiSlopShared;

  const TOOLBAR_ICON_PATHS = {
    idle: { 16: 'icons/icon-idle-16.png', 32: 'icons/icon-idle-32.png' },
    active: { 16: 'icons/icon-active-16.png', 32: 'icons/icon-active-32.png' },
    paused: { 16: 'icons/icon-paused-16.png', 32: 'icons/icon-paused-32.png' },
  };

  const STORAGE_KEYS = {
    SETTINGS: 'antislop_settings',
    REMOTE_BLACKLIST: 'antislop_blacklist',
    BLACKLIST_CURSOR: 'antislop_blacklist_cursor',
    LOCAL_BLACKLIST: 'antislop_local_blacklist',
    WHITELIST: 'antislop_whitelist',
    BLOCKED_TWEETS: 'antislop_blocked_tweets',
    ALLOWED_TWEETS: 'antislop_allowed_tweets',
    COUNTED_TWEETS: 'antislop_counted_tweets',
    RECENT_INTERCEPTED: 'antislop_recent_intercepted',
    STATS: 'antislop_stats',
    CLIENT_ID: 'antislop_client_id',
  };

  const SESSION_KEYS = {
    VERDICT_CACHE: 'antislop_session_verdict_cache',
    AUTO_ACCOUNTS: 'antislop_session_auto_accounts',
  };

  const MAX_COUNTED_IDS = 2000;
  const MAX_BLOCKED_TWEETS = 1000;
  const MAX_ALLOWED_TWEETS = 1000;
  const MAX_RECENT_INTERCEPTED = 100;
  const MAX_VERDICT_CACHE = 1500;
  const MAX_SESSION_ACCOUNTS = 500;
  const VERDICT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  const SIGNAL_TIMEOUT_MS = 4000;

  function normalizeList(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const item of arr) {
      const n = normalizeHandle(item);
      if (n && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  }

  function areHandleListsEqual(a = [], b = []) {
    const na = normalizeList(a).sort();
    const nb = normalizeList(b).sort();
    return na.length === nb.length && na.every((v, i) => v === nb[i]);
  }

  function computeEffectiveBlacklistSet(remoteArr = [], localArr = [], whitelistArr = []) {
    const wl = new Set(normalizeList(whitelistArr));
    const effective = new Set();
    for (const h of [...normalizeList(remoteArr), ...normalizeList(localArr)]) {
      if (!wl.has(h)) effective.add(h);
    }
    return effective;
  }

  function addToBoundedList(arr, value, max) {
    const set = new Set(Array.isArray(arr) ? arr.filter(Boolean).map(String) : []);
    if (value) {
      const s = String(value);
      set.delete(s);
      set.add(s);
    }
    while (set.size > max) set.delete(set.values().next().value);
    return Array.from(set);
  }

  function buildDefaultStats(prev = {}) {
    return {
      filteredCount: Number(prev.filteredCount || 0),
      accountInterceptCounts:
        prev.accountInterceptCounts && typeof prev.accountInterceptCounts === 'object'
          ? { ...prev.accountInterceptCounts }
          : {},
      mode: prev.mode || 'local',
      backendOnline: Boolean(prev.backendOnline),
      lastSyncAt: prev.lastSyncAt || '',
      lastError: prev.lastError || '',
      remoteBlacklistCount: Number(prev.remoteBlacklistCount || 0),
      remoteSlopPostCount: Number(prev.remoteSlopPostCount || 0),
      lastSeenStageId:
        typeof prev.lastSeenStageId === 'string' && getBakuStageIndex(prev.lastSeenStageId) >= 0
          ? prev.lastSeenStageId
          : '',
    };
  }

  function recordRecentIntercepted(existingList, newEntries) {
    const out = [];
    const seen = new Set();
    const pushIfNew = (entry) => {
      if (!entry || !entry.tweetId) return;
      const key = String(entry.tweetId);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        tweetId: key,
        handle: normalizeHandle(entry.handle),
        matchedHandle: normalizeHandle(entry.matchedHandle || entry.handle),
        displayName: typeof entry.displayName === 'string' ? entry.displayName.slice(0, 120) : '',
        text: typeof entry.text === 'string' ? entry.text.slice(0, 600) : '',
        quotedHandle: normalizeHandle(entry.quotedHandle || ''),
        quotedText: typeof entry.quotedText === 'string' ? entry.quotedText.slice(0, 300) : '',
        parentHandle: normalizeHandle(entry.parentHandle || ''),
        parentText: typeof entry.parentText === 'string' ? entry.parentText.slice(0, 240) : '',
        isReply: Boolean(entry.isReply),
        isVerified: Boolean(entry.isVerified),
        slopProb: typeof entry.slopProb === 'number' && Number.isFinite(entry.slopProb) ? entry.slopProb : null,
        scope: entry.scope === 'ACCOUNT' ? 'ACCOUNT' : 'TWEET',
        source: entry.source || 'ai_model',
        reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 200) : '',
        interceptedAt: entry.interceptedAt || new Date().toISOString(),
      });
    };
    for (let i = newEntries.length - 1; i >= 0; i -= 1) pushIfNew(newEntries[i]);
    if (Array.isArray(existingList)) existingList.forEach(pushIfNew);
    return out.slice(0, MAX_RECENT_INTERCEPTED);
  }

  function resolveOriginalSignalFields(snap = {}, cachedVerdict = null, fallbackVerdict = '') {
    const verdict = snap?.origVerdict || snap?.verdict || cachedVerdict?.verdict || fallbackVerdict || '';
    const rawProb = snap?.origSlopProb ?? snap?.slopProb ?? cachedVerdict?.slopProb;
    const slopProb = typeof rawProb === 'number' && Number.isFinite(rawProb) ? rawProb : null;
    const source = snap?.origSource || snap?.source || cachedVerdict?.source || '';
    return { origVerdict: verdict, origSlopProb: slopProb, origSource: source };
  }

  function buildHeaders(settings, withJson = false) {
    const headers = {};
    if (withJson) headers['Content-Type'] = 'application/json';
    if (settings.flywheelToken && settings.flywheelToken.trim()) {
      headers.Authorization = `Bearer ${settings.flywheelToken.trim()}`;
    }
    return headers;
  }

  function buildDisabledResults(items) {
    return {
      results: items.map((it) => {
        const h = normalizeHandle(it?.handle || '');
        return {
          tweetId: it?.tweetId ?? null,
          handle: h,
          matchedHandle: h,
          verdict: 'ALLOW',
          scope: 'TWEET',
          source: 'disabled',
          reason: 'Filtering disabled',
        };
      }),
    };
  }

  function createBackgroundController({
    chromeApi = rootScope.chrome,
    fetchImpl = (...args) => rootScope.fetch(...args),
    defaultFlywheelUrl,
    renderCornerIcon = null,
  } = {}) {
    const resolvedDefaultUrl =
      defaultFlywheelUrl !== undefined
        ? String(defaultFlywheelUrl || '').trim().replace(/\/+$/, '')
        : String(DEFAULT_FLYWHEEL_URL || '').trim().replace(/\/+$/, '');

    let storageLock = Promise.resolve();
    const withStorageLock = (fn) => {
      const run = storageLock.then(fn, fn);
      storageLock = run.catch(() => {});
      return run;
    };
    const getStorage = (keys) => chromeApi.storage.local.get(keys);
    const setStorage = (obj) => chromeApi.storage.local.set(obj);

    const verdictCache = new Map();
    const autoSessionAccounts = new Set();
    const tabFilteredCounts = new Map();
    const baseBitmapCache = new Map();
    const cornerIconCache = new Map();
    let sessionHydrated = false;

    async function hydrateSessionCaches() {
      if (sessionHydrated) return;
      sessionHydrated = true;
      const sessionStore = chromeApi?.storage?.session;
      if (!sessionStore?.get) return;
      try {
        const res = await sessionStore.get([SESSION_KEYS.VERDICT_CACHE, SESSION_KEYS.AUTO_ACCOUNTS]);
        const now = Date.now();
        for (const item of res?.[SESSION_KEYS.VERDICT_CACHE] || []) {
          if (item && item.key && item.value && Number(item.expiresAt) > now) {
            verdictCache.set(item.key, { expiresAt: item.expiresAt, value: item.value });
          }
        }
        for (const h of normalizeList(res?.[SESSION_KEYS.AUTO_ACCOUNTS] || [])) {
          autoSessionAccounts.add(h);
        }
      } catch {
        // ignore session storage errors
      }
    }

    async function persistSessionCaches() {
      const sessionStore = chromeApi?.storage?.session;
      if (!sessionStore?.set) return;
      try {
        const entries = Array.from(verdictCache.entries())
          .slice(-MAX_VERDICT_CACHE)
          .map(([key, v]) => ({ key, expiresAt: v.expiresAt, value: v.value }));
        await sessionStore.set({
          [SESSION_KEYS.VERDICT_CACHE]: entries,
          [SESSION_KEYS.AUTO_ACCOUNTS]: Array.from(autoSessionAccounts).slice(-MAX_SESSION_ACCOUNTS),
        });
      } catch {
        // ignore session storage errors
      }
    }

    function readVerdictCache(tweetId) {
      if (!tweetId) return null;
      const key = String(tweetId);
      const entry = verdictCache.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        verdictCache.delete(key);
        return null;
      }
      verdictCache.delete(key);
      verdictCache.set(key, entry);
      return entry.value;
    }

    function writeVerdictCache(tweetId, value) {
      if (!tweetId || !value) return;
      const key = String(tweetId);
      if (verdictCache.has(key)) verdictCache.delete(key);
      verdictCache.set(key, { expiresAt: Date.now() + VERDICT_CACHE_TTL_MS, value });
      while (verdictCache.size > MAX_VERDICT_CACHE) {
        verdictCache.delete(verdictCache.keys().next().value);
      }
    }

    function clearVerdictCache({ tweetId = null, handle = '' } = {}) {
      const norm = normalizeHandle(handle);
      if (tweetId) {
        verdictCache.delete(String(tweetId));
      }
      if (norm) {
        autoSessionAccounts.delete(norm);
        for (const [k, entry] of Array.from(verdictCache.entries())) {
          if (entry?.value?.handle === norm || entry?.value?.matchedHandle === norm) {
            verdictCache.delete(k);
          }
        }
      }
    }

    function addSessionAccount(handle) {
      const norm = normalizeHandle(handle);
      if (!norm) return;
      autoSessionAccounts.delete(norm);
      autoSessionAccounts.add(norm);
      while (autoSessionAccounts.size > MAX_SESSION_ACCOUNTS) {
        autoSessionAccounts.delete(autoSessionAccounts.values().next().value);
      }
    }

    function getEffectiveFlywheelUrl(settings) {
      return resolveFlywheelUrl(settings, resolvedDefaultUrl);
    }

    function readNormalizedLists(storage = {}) {
      const settings = normalizeSettings(storage[STORAGE_KEYS.SETTINGS] || {});
      const whitelist = normalizeList(storage[STORAGE_KEYS.WHITELIST]);
      const whitelistSet = new Set(whitelist);
      const localBlacklist = normalizeList(storage[STORAGE_KEYS.LOCAL_BLACKLIST]);
      const remoteBlacklist = normalizeList(storage[STORAGE_KEYS.REMOTE_BLACKLIST]);
      const blacklistSet = computeEffectiveBlacklistSet(remoteBlacklist, localBlacklist, whitelist);
      const blockedTweetsSet = new Set((storage[STORAGE_KEYS.BLOCKED_TWEETS] || []).map(String));
      const allowedTweetsSet = new Set((storage[STORAGE_KEYS.ALLOWED_TWEETS] || []).map(String));
      return {
        settings,
        whitelist,
        whitelistSet,
        localBlacklist,
        remoteBlacklist,
        blacklistSet,
        blockedTweetsSet,
        allowedTweetsSet,
      };
    }

    async function getSettings() {
      const res = await getStorage([STORAGE_KEYS.SETTINGS]);
      return normalizeSettings(res[STORAGE_KEYS.SETTINGS] || {});
    }

    async function getOrCreateClientId() {
      return withStorageLock(async () => {
        const res = await getStorage([STORAGE_KEYS.CLIENT_ID]);
        if (res[STORAGE_KEYS.CLIENT_ID]) return res[STORAGE_KEYS.CLIENT_ID];
        const randomPart =
          rootScope.crypto && typeof rootScope.crypto.randomUUID === 'function'
            ? rootScope.crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const id = `ext-${randomPart}`;
        await setStorage({ [STORAGE_KEYS.CLIENT_ID]: id });
        return id;
      });
    }

    async function sendFlywheelSignal(settings, payload) {
      const baseUrl = getEffectiveFlywheelUrl(settings);
      if (!baseUrl) return { ok: false, skipped: true };

      const clientId = await getOrCreateClientId();
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), SIGNAL_TIMEOUT_MS) : null;

      try {
        const res = await fetchImpl(`${baseUrl}/api/v1/signal`, {
          method: 'POST',
          headers: buildHeaders(settings, true),
          body: JSON.stringify({ ...payload, clientId }),
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (!res || !res.ok) return { ok: false, status: res?.status || 0 };
        const data = await res.json();

        const targetHandle = normalizeHandle(payload.handle || '');
        if (targetHandle && data.blacklisted === true && payload.type === 'BLOCK_ACCOUNT') {
          await withStorageLock(async () => {
            const cur = await getStorage([STORAGE_KEYS.REMOTE_BLACKLIST, STORAGE_KEYS.WHITELIST]);
            const wlSet = new Set(normalizeList(cur[STORAGE_KEYS.WHITELIST]));
            if (!wlSet.has(targetHandle)) {
              const nextRemote = normalizeList([...(cur[STORAGE_KEYS.REMOTE_BLACKLIST] || []), targetHandle]);
              await setStorage({ [STORAGE_KEYS.REMOTE_BLACKLIST]: nextRemote });
            }
          });
        } else if (targetHandle && data.removedFromBlacklist === true) {
          await withStorageLock(async () => {
            const cur = await getStorage([STORAGE_KEYS.REMOTE_BLACKLIST]);
            const nextRemote = normalizeList(cur[STORAGE_KEYS.REMOTE_BLACKLIST]).filter((h) => h !== targetHandle);
            await setStorage({ [STORAGE_KEYS.REMOTE_BLACKLIST]: nextRemote });
          });
        }

        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err?.message || 'SIGNAL_FAILED' };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function syncBlacklist({ full = false, includeHealth = false } = {}) {
      const settings = await getSettings();
      const baseUrl = getEffectiveFlywheelUrl(settings);
      if (!baseUrl) {
        return withStorageLock(async () => {
          const prev = await getStorage([STORAGE_KEYS.STATS, STORAGE_KEYS.REMOTE_BLACKLIST]);
          const stats = {
            ...buildDefaultStats(prev[STORAGE_KEYS.STATS]),
            mode: 'local',
            backendOnline: false,
            lastError: '',
            remoteBlacklistCount: normalizeList(prev[STORAGE_KEYS.REMOTE_BLACKLIST]).length,
          };
          await setStorage({ [STORAGE_KEYS.STATS]: stats });
          return { ok: true, mode: 'local', stats };
        });
      }

      try {
        const pre = await getStorage([STORAGE_KEYS.BLACKLIST_CURSOR]);
        const cursor = pre[STORAGE_KEYS.BLACKLIST_CURSOR] || null;
        let query = '';
        if (!full && cursor && cursor.version != null && Number.isFinite(Number(cursor.version))) {
          query = `?sinceVersion=${Number(cursor.version)}`;
        } else if (!full && cursor && cursor.updatedAt) {
          query = `?since=${encodeURIComponent(cursor.updatedAt)}`;
        }

        const headers = buildHeaders(settings, false);
        const [blRes, healthRes] = await Promise.all([
          fetchImpl(`${baseUrl}/api/v1/blacklist${query}`, { headers }),
          includeHealth ? fetchImpl(`${baseUrl}/health`, { headers }).catch(() => null) : Promise.resolve(null),
        ]);
        if (!blRes.ok) throw new Error(`HTTP ${blRes.status}`);
        const blData = await blRes.json();
        const health = healthRes && healthRes.ok ? await healthRes.json() : null;

        const incomingHandles = normalizeList(
          (Array.isArray(blData.accounts) ? blData.accounts : []).map((a) => (typeof a === 'string' ? a : a?.handle))
        );
        const removedSet = new Set(normalizeList(Array.isArray(blData.removed) ? blData.removed : []));
        const isIncremental = Boolean(blData.incremental);

        return withStorageLock(async () => {
          const prev = await getStorage([STORAGE_KEYS.STATS, STORAGE_KEYS.REMOTE_BLACKLIST, STORAGE_KEYS.WHITELIST]);
          const prevRemote = normalizeList(prev[STORAGE_KEYS.REMOTE_BLACKLIST]);
          const wlSet = new Set(normalizeList(prev[STORAGE_KEYS.WHITELIST]));

          let mergedRemote;
          if (isIncremental) {
            const retained = prevRemote.filter((h) => !removedSet.has(h));
            mergedRemote = normalizeList([...retained, ...incomingHandles]).filter((h) => !wlSet.has(h));
          } else {
            mergedRemote = incomingHandles.filter((h) => !wlSet.has(h));
          }

          const nextCursor = {
            version: typeof blData.version === 'number' ? blData.version : cursor?.version ?? null,
            updatedAt: blData.updatedAt || new Date().toISOString(),
          };
          const stats = {
            ...buildDefaultStats(prev[STORAGE_KEYS.STATS]),
            mode: 'remote',
            backendOnline: true,
            lastSyncAt: new Date().toISOString(),
            lastError: '',
            remoteBlacklistCount: mergedRemote.length,
            ...(health && typeof health.slopPostCount === 'number'
              ? { remoteSlopPostCount: health.slopPostCount }
              : {}),
          };

          const patch = {
            [STORAGE_KEYS.STATS]: stats,
            [STORAGE_KEYS.BLACKLIST_CURSOR]: nextCursor,
          };
          if (!areHandleListsEqual(prevRemote, mergedRemote)) {
            patch[STORAGE_KEYS.REMOTE_BLACKLIST] = mergedRemote;
          }
          await setStorage(patch);
          return { ok: true, mode: 'remote', count: mergedRemote.length, stats };
        });
      } catch (err) {
        return withStorageLock(async () => {
          const prev = await getStorage([STORAGE_KEYS.STATS]);
          const stats = {
            ...buildDefaultStats(prev[STORAGE_KEYS.STATS]),
            mode: 'remote_error',
            backendOnline: false,
            lastError: err.message || 'Sync error',
          };
          await setStorage({ [STORAGE_KEYS.STATS]: stats });
          return { ok: false, error: err.message, stats };
        });
      }
    }

    async function refreshRemoteHealth() {
      const settings = await getSettings();
      const baseUrl = getEffectiveFlywheelUrl(settings);
      if (!baseUrl) {
        return { ok: true, mode: 'local' };
      }
      try {
        const res = await fetchImpl(`${baseUrl}/health`, { headers: buildHeaders(settings, false) });
        if (!res || !res.ok) throw new Error(`HTTP ${res?.status || 0}`);
        const health = await res.json();
        return withStorageLock(async () => {
          const prev = await getStorage([STORAGE_KEYS.STATS]);
          const stats = {
            ...buildDefaultStats(prev[STORAGE_KEYS.STATS]),
            mode: 'remote',
            backendOnline: true,
            lastError: '',
            ...(health && typeof health.slopPostCount === 'number'
              ? { remoteSlopPostCount: health.slopPostCount }
              : {}),
          };
          await setStorage({ [STORAGE_KEYS.STATS]: stats });
          return { ok: true, mode: 'remote', stats };
        });
      } catch (err) {
        return { ok: false, error: err?.message || 'Health check error' };
      }
    }

    function applySlopInterceptionStats(latest, pairs = []) {
      const countedList = Array.isArray(latest[STORAGE_KEYS.COUNTED_TWEETS])
        ? latest[STORAGE_KEYS.COUNTED_TWEETS].map(String)
        : [];
      const countedSet = new Set(countedList);
      const stats = buildDefaultStats(latest[STORAGE_KEYS.STATS]);
      let newlyFiltered = 0;
      const recentToAdd = [];
      const now = new Date().toISOString();

      for (const pair of pairs) {
        const r = pair?.result;
        const it = pair?.item || {};
        const tweetId = r?.tweetId || it?.tweetId;
        if (!r || r.verdict !== 'SLOP' || !tweetId) continue;

        const idStr = String(tweetId);
        if (countedSet.has(idStr)) continue;
        countedSet.add(idStr);
        countedList.push(idStr);
        newlyFiltered += 1;

        const owner = normalizeHandle(r.matchedHandle || r.handle || it.handle);
        if (owner && r.scope === 'ACCOUNT') {
          stats.accountInterceptCounts[owner] = (stats.accountInterceptCounts[owner] || 0) + 1;
        }

        recentToAdd.push({
          tweetId: idStr,
          handle: r.handle || it.handle || '',
          matchedHandle: r.matchedHandle || r.handle || it.handle || '',
          displayName: it.displayName || '',
          text: it.text || '',
          quotedHandle: it.quotedHandle || '',
          quotedText: it.quotedText || '',
          parentHandle: it.parentHandle || '',
          parentText: it.parentText || '',
          isReply: Boolean(it.isReply),
          isVerified: Boolean(it.isVerified),
          slopProb: typeof r.slopProb === 'number' && Number.isFinite(r.slopProb) ? r.slopProb : null,
          scope: r.scope || 'TWEET',
          source: r.source || 'ai_model',
          reason: r.reason || '',
          interceptedAt: now,
        });
      }

      if (newlyFiltered > 0) {
        stats.filteredCount += newlyFiltered;
      }

      return {
        newlyFiltered,
        trimmedCounted: countedList.slice(-MAX_COUNTED_IDS),
        recentIntercepted: recordRecentIntercepted(latest[STORAGE_KEYS.RECENT_INTERCEPTED], recentToAdd),
        stats,
      };
    }

    async function classifyBatch(items = []) {
      if (!Array.isArray(items) || items.length === 0) return { results: [] };
      await hydrateSessionCaches();

      const initLists = readNormalizedLists(
        await getStorage([
          STORAGE_KEYS.SETTINGS,
          STORAGE_KEYS.REMOTE_BLACKLIST,
          STORAGE_KEYS.LOCAL_BLACKLIST,
          STORAGE_KEYS.WHITELIST,
          STORAGE_KEYS.BLOCKED_TWEETS,
          STORAGE_KEYS.ALLOWED_TWEETS,
        ])
      );
      if (!initLists.settings.enabled) return buildDisabledResults(items);

      const settings = initLists.settings;
      const baseUrl = getEffectiveFlywheelUrl(settings);
      const listsWithSession = {
        ...initLists,
        sessionAccountsSet: autoSessionAccounts,
      };

      const immediateResults = new Map();
      const aiByokPending = [];
      const aiRemotePending = [];

      const runEval = (it, activeLists) =>
        evaluateLocalRules(it, activeLists, {
          selfHandle: it.selfHandle || '',
        });

      for (const item of items) {
        const localRes = runEval(item, listsWithSession);
        if (localRes.verdict === 'SLOP' || localRes.source !== 'allow') {
          immediateResults.set(item.tweetId, localRes);
          continue;
        }

        const cached = readVerdictCache(item.tweetId);
        if (cached) {
          const cachedMatched = normalizeHandle(cached.matchedHandle);
          if (cachedMatched && initLists.whitelistSet.has(cachedMatched)) {
            immediateResults.set(item.tweetId, {
              ...cached,
              verdict: 'ALLOW',
              scope: 'TWEET',
              source: 'whitelist',
              reason: 'Account in whitelist',
            });
          } else {
            if (cached.verdict === 'SLOP' && cached.scope === 'ACCOUNT' && cachedMatched) {
              addSessionAccount(cachedMatched);
            }
            immediateResults.set(item.tweetId, cached);
          }
          continue;
        }

        const wantsAi = shouldQueryAiClassifier(item, settings.aiScanScope);
        if (wantsAi && settings.aiEnabled && settings.aiApiKey) {
          aiByokPending.push(item);
        } else if (wantsAi && baseUrl) {
          aiRemotePending.push(item);
        } else {
          immediateResults.set(item.tweetId, localRes);
        }
      }

      const aiResultMap = new Map();
      if (aiByokPending.length > 0) {
        const aiDecisions = await classifyWithAi(
          aiByokPending,
          {
            apiKey: settings.aiApiKey,
            baseUrl: settings.aiBaseUrl,
            model: settings.aiModel,
          },
          fetchImpl
        );
        for (let i = 0; i < aiByokPending.length; i += 1) {
          const item = aiByokPending[i];
          const dec = aiDecisions[i];
          if (dec) {
            aiResultMap.set(item.tweetId, dec);
            if (dec.source !== 'ai_fallback_allow') {
              writeVerdictCache(item.tweetId, dec);
            }
            const decHandle = normalizeHandle(dec.matchedHandle);
            if (dec.verdict === 'SLOP' && dec.scope === 'ACCOUNT' && decHandle && !initLists.whitelistSet.has(decHandle)) {
              addSessionAccount(decHandle);
            }
          }
        }
      }

      if (aiRemotePending.length > 0 && baseUrl) {
        const clientId = await getOrCreateClientId();
        for (let offset = 0; offset < aiRemotePending.length; offset += 25) {
          const chunk = aiRemotePending.slice(offset, offset + 25);
          try {
            const res = await fetchImpl(`${baseUrl}/api/v1/classify/batch`, {
              method: 'POST',
              headers: buildHeaders(settings, true),
              body: JSON.stringify({
                clientId,
                whitelist: initLists.whitelist,
                items: chunk,
              }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const list = Array.isArray(data.results) ? data.results : [];
            for (let i = 0; i < chunk.length; i += 1) {
              const item = chunk[i];
              const dec = list.find((r) => r && r.tweetId === item.tweetId) || list[i];
              if (dec) {
                aiResultMap.set(item.tweetId, dec);
                if (dec.source !== 'ai_fallback_allow' && dec.source !== 'rate_limited_allow') {
                  writeVerdictCache(item.tweetId, dec);
                }
                const decHandle = normalizeHandle(dec.matchedHandle);
                if (dec.verdict === 'SLOP' && dec.scope === 'ACCOUNT' && decHandle && !initLists.whitelistSet.has(decHandle)) {
                  addSessionAccount(decHandle);
                }
              }
            }
          } catch {
            for (const item of chunk) {
              aiResultMap.set(item.tweetId, runEval(item, listsWithSession));
            }
          }
        }
      }

      const finalOutcome = await withStorageLock(async () => {
        const latest = await getStorage([
          STORAGE_KEYS.SETTINGS,
          STORAGE_KEYS.REMOTE_BLACKLIST,
          STORAGE_KEYS.LOCAL_BLACKLIST,
          STORAGE_KEYS.WHITELIST,
          STORAGE_KEYS.BLOCKED_TWEETS,
          STORAGE_KEYS.ALLOWED_TWEETS,
          STORAGE_KEYS.COUNTED_TWEETS,
          STORAGE_KEYS.RECENT_INTERCEPTED,
          STORAGE_KEYS.STATS,
        ]);
        const lists = readNormalizedLists(latest);
        if (!lists.settings.enabled) return buildDisabledResults(items);

        const latestListsWithSession = {
          ...lists,
          sessionAccountsSet: autoSessionAccounts,
        };

        const combined = items.map((it) => {
          const override = evaluateLocalRules(it, latestListsWithSession, {
            selfHandle: it.selfHandle || '',
          });
          if (override.verdict === 'SLOP' || override.source !== 'allow') {
            return override;
          }

          const fromImmediate = immediateResults.get(it.tweetId);
          const fromAi = aiResultMap.get(it.tweetId);
          const picked = fromAi || fromImmediate || override;
          const matched = normalizeHandle(picked.matchedHandle);
          if (matched && lists.whitelistSet.has(matched)) {
            return {
              tweetId: it.tweetId,
              handle: normalizeHandle(it.handle),
              matchedHandle: matched,
              verdict: 'ALLOW',
              scope: 'TWEET',
              source: 'whitelist',
              reason: 'Account in whitelist',
            };
          }
          return picked;
        });

        const outcome = applySlopInterceptionStats(
          latest,
          combined.map((result, idx) => ({ item: items[idx] || {}, result }))
        );
        if (outcome.newlyFiltered > 0) {
          await setStorage({
            [STORAGE_KEYS.COUNTED_TWEETS]: outcome.trimmedCounted,
            [STORAGE_KEYS.RECENT_INTERCEPTED]: outcome.recentIntercepted,
            [STORAGE_KEYS.STATS]: outcome.stats,
          });
        }

        return { results: combined };
      });

      await persistSessionCaches();
      return finalOutcome;
    }

    async function reportSlop({
      handle = '',
      displayName = '',
      tweetId = null,
      matchedTweetIds = [],
      scope = 'account',
      text = '',
      quotedHandle = '',
      quotedText = '',
      parentHandle = '',
      parentText = '',
      isReply = false,
      isVerified = false,
      origVerdict = '',
      origSlopProb = null,
      origSource = '',
    }) {
      await hydrateSessionCaches();
      const norm = normalizeHandle(handle);
      const isAccountScope = scope === 'account';
      const now = new Date().toISOString();
      const cachedVerdict = tweetId ? readVerdictCache(tweetId) : null;
      const orig = resolveOriginalSignalFields({ origVerdict, origSlopProb, origSource }, cachedVerdict);

      const localOutcome = await withStorageLock(async () => {
        const res = await getStorage([
          STORAGE_KEYS.SETTINGS,
          STORAGE_KEYS.LOCAL_BLACKLIST,
          STORAGE_KEYS.WHITELIST,
          STORAGE_KEYS.BLOCKED_TWEETS,
          STORAGE_KEYS.ALLOWED_TWEETS,
          STORAGE_KEYS.COUNTED_TWEETS,
          STORAGE_KEYS.RECENT_INTERCEPTED,
          STORAGE_KEYS.STATS,
        ]);

        const settings = normalizeSettings(res[STORAGE_KEYS.SETTINGS] || {});
        const countedList = Array.isArray(res[STORAGE_KEYS.COUNTED_TWEETS])
          ? res[STORAGE_KEYS.COUNTED_TWEETS].map(String)
          : [];
        const countedSet = new Set(countedList);
        const stats = buildDefaultStats(res[STORAGE_KEYS.STATS]);
        let localBl = normalizeList(res[STORAGE_KEYS.LOCAL_BLACKLIST]);
        let wl = normalizeList(res[STORAGE_KEYS.WHITELIST]);
        let blockedTweets = (res[STORAGE_KEYS.BLOCKED_TWEETS] || []).slice();
        let allowedTweets = (res[STORAGE_KEYS.ALLOWED_TWEETS] || []).map(String);

        let newlyFiltered = 0;
        const recentToAdd = [];
        const patch = {};

        if (norm && isAccountScope) {
          if (!localBl.includes(norm)) localBl = [...localBl, norm];
          wl = wl.filter((h) => h !== norm);
          patch[STORAGE_KEYS.LOCAL_BLACKLIST] = localBl;
          patch[STORAGE_KEYS.WHITELIST] = wl;
          clearVerdictCache({ handle: norm });

          if (settings.enabled) {
            const idsToCount = new Set(
              [tweetId, ...(Array.isArray(matchedTweetIds) ? matchedTweetIds : [])].filter(Boolean).map(String)
            );
            if (idsToCount.size > 0) {
              patch[STORAGE_KEYS.ALLOWED_TWEETS] = allowedTweets.filter((id) => !idsToCount.has(id));
            }
            for (const id of idsToCount) {
              if (!countedSet.has(id)) {
                countedSet.add(id);
                countedList.push(id);
                newlyFiltered += 1;
                stats.accountInterceptCounts[norm] = (stats.accountInterceptCounts[norm] || 0) + 1;
              }
            }
            recentToAdd.push({
              tweetId: tweetId ? String(tweetId) : `acct_${norm}`,
              handle: norm,
              matchedHandle: norm,
              displayName,
              text,
              quotedHandle,
              quotedText,
              parentHandle,
              parentText,
              isReply: Boolean(isReply),
              isVerified: Boolean(isVerified),
              slopProb: orig.origSlopProb,
              scope: 'ACCOUNT',
              source: 'user_block',
              reason: '手动拉黑账号',
              interceptedAt: now,
            });
          }
        } else if (scope === 'tweet' && tweetId) {
          const idStr = String(tweetId);
          blockedTweets = addToBoundedList(blockedTweets, idStr, MAX_BLOCKED_TWEETS);
          patch[STORAGE_KEYS.BLOCKED_TWEETS] = blockedTweets;
          patch[STORAGE_KEYS.ALLOWED_TWEETS] = allowedTweets.filter((id) => id !== idStr);
          clearVerdictCache({ tweetId: idStr });

          if (settings.enabled) {
            if (!countedSet.has(idStr)) {
              countedSet.add(idStr);
              countedList.push(idStr);
              newlyFiltered += 1;
            }
            recentToAdd.push({
              tweetId: idStr,
              handle: norm,
              matchedHandle: norm,
              displayName,
              text,
              quotedHandle,
              quotedText,
              parentHandle,
              parentText,
              isReply: Boolean(isReply),
              isVerified: Boolean(isVerified),
              slopProb: orig.origSlopProb,
              scope: 'TWEET',
              source: 'user_block',
              reason: '手动屏蔽单条',
              interceptedAt: now,
            });
          }
        }

        if (recentToAdd.length > 0) {
          patch[STORAGE_KEYS.RECENT_INTERCEPTED] = recordRecentIntercepted(
            res[STORAGE_KEYS.RECENT_INTERCEPTED],
            recentToAdd
          );
        }
        if (newlyFiltered > 0) {
          stats.filteredCount += newlyFiltered;
          patch[STORAGE_KEYS.COUNTED_TWEETS] = countedList.slice(-MAX_COUNTED_IDS);
          patch[STORAGE_KEYS.STATS] = stats;
        }
        if (Object.keys(patch).length > 0) await setStorage(patch);

        return { settings, stats, newlyFiltered };
      });

      const signalRes = await sendFlywheelSignal(localOutcome.settings, {
        type: isAccountScope ? 'BLOCK_ACCOUNT' : 'BLOCK_TWEET',
        handle: norm,
        tweetId: tweetId ? String(tweetId) : '',
        displayName,
        text,
        quotedHandle,
        quotedText,
        parentHandle,
        parentText,
        isReply: Boolean(isReply),
        isVerified: Boolean(isVerified),
        ...orig,
        reason: isAccountScope ? 'USER_BLOCK_ACCOUNT' : 'USER_BLOCK_TWEET',
      });

      return {
        ok: true,
        localOnly: !getEffectiveFlywheelUrl(localOutcome.settings),
        remoteSynced: Boolean(signalRes.ok),
        handle: norm,
        stats: localOutcome.stats,
        newlyFiltered: localOutcome.newlyFiltered,
      };
    }

    async function unblockAccount({ handle, tweetId = null }) {
      await hydrateSessionCaches();
      const norm = normalizeHandle(handle);
      if (!norm) return { ok: false };

      clearVerdictCache({ handle: norm });
      await persistSessionCaches();

      const outcome = await withStorageLock(async () => {
        const res = await getStorage([
          STORAGE_KEYS.SETTINGS,
          STORAGE_KEYS.LOCAL_BLACKLIST,
          STORAGE_KEYS.REMOTE_BLACKLIST,
          STORAGE_KEYS.RECENT_INTERCEPTED,
          STORAGE_KEYS.STATS,
        ]);
        const settings = normalizeSettings(res[STORAGE_KEYS.SETTINGS] || {});
        const recentIntercepted = (res[STORAGE_KEYS.RECENT_INTERCEPTED] || []).filter(
          (e) => !(e && (e.handle === norm || e.matchedHandle === norm) && e.scope === 'ACCOUNT')
        );
        await setStorage({
          [STORAGE_KEYS.LOCAL_BLACKLIST]: normalizeList(res[STORAGE_KEYS.LOCAL_BLACKLIST]).filter((h) => h !== norm),
          [STORAGE_KEYS.REMOTE_BLACKLIST]: normalizeList(res[STORAGE_KEYS.REMOTE_BLACKLIST]).filter((h) => h !== norm),
          [STORAGE_KEYS.RECENT_INTERCEPTED]: recentIntercepted,
        });
        return { settings, stats: buildDefaultStats(res[STORAGE_KEYS.STATS]) };
      });

      await sendFlywheelSignal(outcome.settings, {
        type: 'UNBLOCK_ACCOUNT',
        handle: norm,
        tweetId: tweetId ? String(tweetId) : '',
      });
      return { ok: true, handle: norm, stats: outcome.stats };
    }

    async function unblockTweet({ tweetId }) {
      await hydrateSessionCaches();
      if (!tweetId) return { ok: false };
      const idStr = String(tweetId);
      clearVerdictCache({ tweetId: idStr });
      await persistSessionCaches();

      return withStorageLock(async () => {
        const res = await getStorage([STORAGE_KEYS.BLOCKED_TWEETS, STORAGE_KEYS.RECENT_INTERCEPTED, STORAGE_KEYS.STATS]);
        await setStorage({
          [STORAGE_KEYS.BLOCKED_TWEETS]: (res[STORAGE_KEYS.BLOCKED_TWEETS] || []).map(String).filter((id) => id !== idStr),
          [STORAGE_KEYS.RECENT_INTERCEPTED]: (res[STORAGE_KEYS.RECENT_INTERCEPTED] || []).filter(
            (e) => !(e && String(e.tweetId || '') === idStr)
          ),
        });
        return { ok: true, tweetId: idStr, stats: buildDefaultStats(res[STORAGE_KEYS.STATS]) };
      });
    }

    async function allowTweet({ tweetId, itemSnapshot = null }) {
      await hydrateSessionCaches();
      if (!tweetId) return { ok: false, error: 'tweetId is required' };
      const idStr = String(tweetId);
      const cachedVerdict = readVerdictCache(idStr);
      clearVerdictCache({ tweetId: idStr });
      await persistSessionCaches();

      const outcome = await withStorageLock(async () => {
        const res = await getStorage([
          STORAGE_KEYS.SETTINGS,
          STORAGE_KEYS.ALLOWED_TWEETS,
          STORAGE_KEYS.BLOCKED_TWEETS,
          STORAGE_KEYS.RECENT_INTERCEPTED,
          STORAGE_KEYS.STATS,
        ]);
        const settings = normalizeSettings(res[STORAGE_KEYS.SETTINGS] || {});
        const matchedRecent = (res[STORAGE_KEYS.RECENT_INTERCEPTED] || []).find(
          (e) => e && String(e.tweetId || '') === idStr
        );
        const snap = { ...(matchedRecent || {}), ...(itemSnapshot || {}) };
        await setStorage({
          [STORAGE_KEYS.ALLOWED_TWEETS]: addToBoundedList(res[STORAGE_KEYS.ALLOWED_TWEETS], idStr, MAX_ALLOWED_TWEETS),
          [STORAGE_KEYS.BLOCKED_TWEETS]: (res[STORAGE_KEYS.BLOCKED_TWEETS] || []).map(String).filter((id) => id !== idStr),
          [STORAGE_KEYS.RECENT_INTERCEPTED]: (res[STORAGE_KEYS.RECENT_INTERCEPTED] || []).filter(
            (e) => !(e && String(e.tweetId || '') === idStr)
          ),
        });
        return {
          settings,
          snap,
          hasMatchedRecent: Boolean(matchedRecent),
          stats: buildDefaultStats(res[STORAGE_KEYS.STATS]),
        };
      });

      const orig = resolveOriginalSignalFields(
        outcome.snap,
        cachedVerdict,
        outcome.snap?.source || outcome.hasMatchedRecent ? 'SLOP' : ''
      );
      await sendFlywheelSignal(outcome.settings, {
        type: 'APPEAL_TWEET',
        handle: normalizeHandle(outcome.snap?.matchedHandle || outcome.snap?.handle || ''),
        tweetId: idStr,
        displayName: outcome.snap?.displayName || '',
        text: outcome.snap?.text || '',
        quotedHandle: normalizeHandle(outcome.snap?.quotedHandle || ''),
        quotedText: outcome.snap?.quotedText || '',
        parentHandle: normalizeHandle(outcome.snap?.parentHandle || ''),
        parentText: outcome.snap?.parentText || '',
        isReply: Boolean(outcome.snap?.isReply),
        isVerified: Boolean(outcome.snap?.isVerified),
        ...orig,
        reason: 'USER_ALLOW_TWEET',
      });

      return { ok: true, tweetId: idStr, removedEntry: outcome.snap || null, stats: outcome.stats };
    }

    async function undoAllowTweet({ tweetId, entrySnapshot = null } = {}) {
      await hydrateSessionCaches();
      if (!tweetId) return { ok: false, error: 'tweetId is required' };
      const idStr = String(tweetId);
      clearVerdictCache({ tweetId: idStr });
      await persistSessionCaches();

      return withStorageLock(async () => {
        const res = await getStorage([
          STORAGE_KEYS.ALLOWED_TWEETS,
          STORAGE_KEYS.RECENT_INTERCEPTED,
          STORAGE_KEYS.STATS,
        ]);
        const nextAllowed = (res[STORAGE_KEYS.ALLOWED_TWEETS] || []).map(String).filter((id) => id !== idStr);
        const patch = {
          [STORAGE_KEYS.ALLOWED_TWEETS]: nextAllowed,
        };
        if (entrySnapshot && typeof entrySnapshot === 'object') {
          patch[STORAGE_KEYS.RECENT_INTERCEPTED] = recordRecentIntercepted(
            res[STORAGE_KEYS.RECENT_INTERCEPTED],
            [{ ...entrySnapshot, tweetId: idStr }]
          );
        }
        await setStorage(patch);
        return { ok: true, tweetId: idStr, stats: buildDefaultStats(res[STORAGE_KEYS.STATS]) };
      });
    }

    async function whitelistAccount({ handle, tweetId = null, itemSnapshot = null }) {
      await hydrateSessionCaches();
      const norm = normalizeHandle(handle);
      if (!norm) return { ok: false };

      const cachedVerdict = tweetId ? readVerdictCache(tweetId) : null;
      clearVerdictCache({ handle: norm, tweetId });
      await persistSessionCaches();

      const outcome = await withStorageLock(async () => {
        const storage = await getStorage([
          STORAGE_KEYS.SETTINGS,
          STORAGE_KEYS.WHITELIST,
          STORAGE_KEYS.LOCAL_BLACKLIST,
          STORAGE_KEYS.REMOTE_BLACKLIST,
          STORAGE_KEYS.BLOCKED_TWEETS,
          STORAGE_KEYS.RECENT_INTERCEPTED,
          STORAGE_KEYS.STATS,
        ]);
        const settings = normalizeSettings(storage[STORAGE_KEYS.SETTINGS] || {});
        const tweetIdStr = tweetId ? String(tweetId) : '';
        const prevLocal = normalizeList(storage[STORAGE_KEYS.LOCAL_BLACKLIST]);
        const prevRemote = normalizeList(storage[STORAGE_KEYS.REMOTE_BLACKLIST]);
        const prevRecent = Array.isArray(storage[STORAGE_KEYS.RECENT_INTERCEPTED])
          ? storage[STORAGE_KEYS.RECENT_INTERCEPTED]
          : [];
        const matchedRecent =
          (tweetIdStr && prevRecent.find((e) => e && String(e.tweetId || '') === tweetIdStr)) ||
          prevRecent.find((e) => e && (e.matchedHandle === norm || e.handle === norm));
        const snap = { ...(matchedRecent || {}), ...(itemSnapshot || {}) };

        const matchesRemoved = (e) =>
          Boolean(
            e &&
              (e.matchedHandle === norm ||
                e.handle === norm ||
                (tweetIdStr && String(e.tweetId || '') === tweetIdStr))
          );
        const removedEntries = prevRecent.filter(matchesRemoved);
        const recentIntercepted = prevRecent.filter((e) => !matchesRemoved(e));

        await setStorage({
          [STORAGE_KEYS.WHITELIST]: normalizeList([...(storage[STORAGE_KEYS.WHITELIST] || []), norm]),
          [STORAGE_KEYS.LOCAL_BLACKLIST]: prevLocal.filter((h) => h !== norm),
          [STORAGE_KEYS.REMOTE_BLACKLIST]: prevRemote.filter((h) => h !== norm),
          [STORAGE_KEYS.BLOCKED_TWEETS]: (storage[STORAGE_KEYS.BLOCKED_TWEETS] || [])
            .map(String)
            .filter((id) => !tweetIdStr || id !== tweetIdStr),
          [STORAGE_KEYS.RECENT_INTERCEPTED]: recentIntercepted,
        });
        return {
          settings,
          snap,
          hasMatchedRecent: Boolean(matchedRecent),
          wasLocalBlacklisted: prevLocal.includes(norm),
          wasRemoteBlacklisted: prevRemote.includes(norm),
          removedEntries,
          stats: buildDefaultStats(storage[STORAGE_KEYS.STATS]),
        };
      });

      const orig = resolveOriginalSignalFields(
        outcome.snap,
        cachedVerdict,
        outcome.snap?.source || outcome.hasMatchedRecent ? 'SLOP' : ''
      );
      await sendFlywheelSignal(outcome.settings, {
        type: 'APPEAL_ACCOUNT',
        handle: norm,
        tweetId: tweetId ? String(tweetId) : '',
        displayName: outcome.snap?.displayName || '',
        text: outcome.snap?.text || '',
        quotedHandle: normalizeHandle(outcome.snap?.quotedHandle || ''),
        quotedText: outcome.snap?.quotedText || '',
        parentHandle: normalizeHandle(outcome.snap?.parentHandle || ''),
        parentText: outcome.snap?.parentText || '',
        isReply: Boolean(outcome.snap?.isReply),
        isVerified: Boolean(outcome.snap?.isVerified),
        ...orig,
        reason: 'USER_NOT_SLOP',
      });

      return {
        ok: true,
        handle: norm,
        wasLocalBlacklisted: outcome.wasLocalBlacklisted,
        wasRemoteBlacklisted: outcome.wasRemoteBlacklisted,
        removedEntries: outcome.removedEntries,
        stats: outcome.stats,
      };
    }

    async function undoWhitelistAccount({
      handle,
      wasLocalBlacklisted = false,
      wasRemoteBlacklisted = false,
      entrySnapshots = [],
    } = {}) {
      await hydrateSessionCaches();
      const norm = normalizeHandle(handle);
      if (!norm) return { ok: false, error: 'handle is required' };

      clearVerdictCache({ handle: norm });
      await persistSessionCaches();

      return withStorageLock(async () => {
        const storage = await getStorage([
          STORAGE_KEYS.WHITELIST,
          STORAGE_KEYS.LOCAL_BLACKLIST,
          STORAGE_KEYS.REMOTE_BLACKLIST,
          STORAGE_KEYS.RECENT_INTERCEPTED,
          STORAGE_KEYS.STATS,
        ]);
        const patch = {
          [STORAGE_KEYS.WHITELIST]: normalizeList(storage[STORAGE_KEYS.WHITELIST]).filter((h) => h !== norm),
        };
        if (wasLocalBlacklisted) {
          patch[STORAGE_KEYS.LOCAL_BLACKLIST] = normalizeList([
            ...(storage[STORAGE_KEYS.LOCAL_BLACKLIST] || []),
            norm,
          ]);
        }
        if (wasRemoteBlacklisted) {
          patch[STORAGE_KEYS.REMOTE_BLACKLIST] = normalizeList([
            ...(storage[STORAGE_KEYS.REMOTE_BLACKLIST] || []),
            norm,
          ]);
        }
        const validSnapshots = Array.isArray(entrySnapshots)
          ? entrySnapshots.filter((e) => e && e.tweetId)
          : [];
        if (validSnapshots.length > 0) {
          patch[STORAGE_KEYS.RECENT_INTERCEPTED] = recordRecentIntercepted(
            storage[STORAGE_KEYS.RECENT_INTERCEPTED],
            validSnapshots.slice().reverse()
          );
        }
        await setStorage(patch);
        return { ok: true, handle: norm, stats: buildDefaultStats(storage[STORAGE_KEYS.STATS]) };
      });
    }

    async function removeWhitelist(handle) {
      const norm = normalizeHandle(handle);
      const whitelist = await withStorageLock(async () => {
        const storage = await getStorage([STORAGE_KEYS.WHITELIST]);
        const wl = normalizeList(storage[STORAGE_KEYS.WHITELIST]).filter((h) => h !== norm);
        await setStorage({ [STORAGE_KEYS.WHITELIST]: wl });
        return wl;
      });
      return { ok: true, whitelist };
    }

    async function ensureSyncAlarm(periodMinutes = 15) {
      if (chromeApi?.alarms?.create) {
        try {
          await chromeApi.alarms.create('antislop_sync', { periodInMinutes: Math.max(1, Number(periodMinutes) || 15) });
        } catch {
          // ignore
        }
      }
    }

    async function clearSyncAlarm() {
      if (chromeApi?.alarms?.clear) {
        try {
          await chromeApi.alarms.clear('antislop_sync');
        } catch {
          // ignore
        }
      }
    }

    async function reinjectOpenXTabs() {
      if (!chromeApi?.tabs?.query || !chromeApi?.scripting?.executeScript) return;
      try {
        const tabs = await chromeApi.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
        for (const tab of tabs || []) {
          if (!tab || tab.id == null) continue;
          if (chromeApi.scripting.insertCSS) {
            await chromeApi.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/content.css'] }).catch(() => {});
          }
          await chromeApi.scripting
            .executeScript({ target: { tabId: tab.id }, files: ['src/shared.js', 'src/content.js'] })
            .catch(() => {});
        }
      } catch {
        // ignore
      }
    }

    async function updateSettings(partialSettings) {
      await hydrateSessionCaches();
      const result = await withStorageLock(async () => {
        const res = await getStorage([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.STATS]);
        const current = normalizeSettings(res[STORAGE_KEYS.SETTINGS] || {});
        const updated = normalizeSettings({ ...current, ...(partialSettings || {}) });
        const prevBaseUrl = getEffectiveFlywheelUrl(current);
        const nextBaseUrl = getEffectiveFlywheelUrl(updated);
        const patch = { [STORAGE_KEYS.SETTINGS]: updated };

        if (prevBaseUrl !== nextBaseUrl) {
          patch[STORAGE_KEYS.BLACKLIST_CURSOR] = null;
        }
        if (!nextBaseUrl) {
          patch[STORAGE_KEYS.STATS] = {
            ...buildDefaultStats(res[STORAGE_KEYS.STATS]),
            mode: 'local',
            backendOnline: false,
            lastError: '',
          };
        }
        await setStorage(patch);
        return {
          current,
          updated,
          prevBaseUrl,
          nextBaseUrl,
          syncIntervalChanged: updated.syncIntervalMinutes !== current.syncIntervalMinutes,
        };
      });

      const rulesOrAiChanged =
        result.updated.aiEnabled !== result.current.aiEnabled ||
        result.updated.aiModel !== result.current.aiModel ||
        result.updated.aiScanScope !== result.current.aiScanScope ||
        result.updated.flywheelEnabled !== result.current.flywheelEnabled ||
        result.updated.flywheelUrl !== result.current.flywheelUrl;

      if (rulesOrAiChanged) {
        verdictCache.clear();
        await persistSessionCaches();
      }

      const next = result.updated;
      if (!result.nextBaseUrl) {
        await clearSyncAlarm();
      } else if (result.syncIntervalChanged || !result.prevBaseUrl) {
        await ensureSyncAlarm(next.syncIntervalMinutes);
      }
      if (next.enabled !== result.current.enabled || next.badgeMode !== result.current.badgeMode) {
        await syncAllToolbarAppearances(next);
      }
      return { ok: true, settings: next };
    }

    async function loadBaseCornerBitmap(size) {
      if (baseBitmapCache.has(size)) return baseBitmapCache.get(size);
      const getUrl = chromeApi?.runtime?.getURL;
      if (
        typeof getUrl !== 'function' ||
        typeof OffscreenCanvas !== 'function' ||
        typeof createImageBitmap !== 'function' ||
        typeof fetchImpl !== 'function'
      ) {
        return null;
      }
      const res = await fetchImpl(getUrl(`icons/icon-active-${size}.png`));
      if (!res || !res.ok) return null;
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(bitmap, 0, 0, size, size);
        const raw = new Uint8ClampedArray(ctx.getImageData(0, 0, size, size).data);
        baseBitmapCache.set(size, raw);
        return raw;
      } finally {
        if (typeof bitmap.close === 'function') bitmap.close();
      }
    }

    async function getCornerCountImageData(count) {
      const num = Math.max(0, Math.floor(Number(count) || 0));
      if (num <= 0) return null;
      const cacheKey = num > 99 ? '99+' : String(num);
      if (cornerIconCache.has(cacheKey)) return cornerIconCache.get(cacheKey);

      try {
        let imageDataMap = null;
        if (typeof renderCornerIcon === 'function') {
          imageDataMap = await renderCornerIcon(num);
        } else if (typeof ImageData === 'function' && typeof paintToolbarCornerCount === 'function') {
          const [raw16, raw32] = await Promise.all([loadBaseCornerBitmap(16), loadBaseCornerBitmap(32)]);
          if (!raw16 || !raw32) return null;
          const buf16 = new Uint8ClampedArray(raw16);
          const buf32 = new Uint8ClampedArray(raw32);
          paintToolbarCornerCount(buf16, 16, num);
          paintToolbarCornerCount(buf32, 32, num);
          imageDataMap = {
            16: new ImageData(buf16, 16, 16),
            32: new ImageData(buf32, 32, 32),
          };
        }
        if (imageDataMap) {
          cornerIconCache.set(cacheKey, imageDataMap);
        }
        return imageDataMap || null;
      } catch {
        return null;
      }
    }

    async function applyActionAppearance({ tabId = null, count = 0, settings } = {}) {
      const action = chromeApi?.action;
      if (!action) return { ok: true, skipped: true };

      const enabled = settings?.enabled !== false;
      const badgeMode = normalizeBadgeMode(settings?.badgeMode);
      const num = Math.max(0, Math.floor(Number(count) || 0));
      const title = !enabled
        ? 'Baku · 已暂停'
        : num > 0
          ? `Baku · 本页已吞掉 ${num} 条`
          : 'Baku · 静默守候中';
      const iconKey = !enabled ? 'paused' : badgeMode === 'corner' && num > 0 ? 'active' : 'idle';
      const text = enabled && badgeMode === 'count' && num > 0 ? (num > 99 ? '99+' : String(num)) : '';
      const tabScope = tabId != null ? { tabId } : {};

      let usedCornerImageData = false;
      if (typeof action.setIcon === 'function') {
        try {
          if (iconKey === 'active') {
            const imageData = await getCornerCountImageData(num);
            if (imageData) {
              await action.setIcon({ ...tabScope, imageData });
              usedCornerImageData = true;
            } else {
              await action.setIcon({ ...tabScope, path: TOOLBAR_ICON_PATHS.active });
            }
          } else {
            await action.setIcon({ ...tabScope, path: TOOLBAR_ICON_PATHS[iconKey] });
          }
        } catch {
          // ignore
        }
      }
      if (typeof action.setTitle === 'function') {
        try {
          await action.setTitle({ ...tabScope, title });
        } catch {
          // ignore
        }
      }
      if (typeof action.setBadgeText === 'function') {
        try {
          await action.setBadgeText({ ...tabScope, text });
          if (text && typeof action.setBadgeBackgroundColor === 'function') {
            await action.setBadgeBackgroundColor({ ...tabScope, color: '#1D6F63' });
          }
          if (text && typeof action.setBadgeTextColor === 'function') {
            await action.setBadgeTextColor({ ...tabScope, color: '#FAF9F5' });
          }
        } catch {
          // ignore
        }
      }

      return { ok: true, text, icon: iconKey, title, usedCornerImageData };
    }

    async function syncAllToolbarAppearances(settingsInput = null) {
      const settings = settingsInput || (await getSettings());
      await applyActionAppearance({ tabId: null, count: 0, settings });
      for (const [tabId, count] of tabFilteredCounts.entries()) {
        await applyActionAppearance({ tabId, count, settings });
      }
    }

    function clearTabBadgeState(tabId) {
      if (tabId != null) tabFilteredCounts.delete(tabId);
    }

    async function updateBadge({ count = 0 } = {}, sender = null) {
      const tabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
      if (tabId == null || !chromeApi.action) {
        return { ok: true, skipped: true };
      }
      const num = Math.max(0, Number(count) || 0);
      tabFilteredCounts.set(tabId, num);
      const settings = await getSettings();
      return applyActionAppearance({ tabId, count: num, settings });
    }

    async function importUserData({ data = {} } = {}) {
      if (!data || typeof data !== 'object') return { ok: false, error: '无效的导入数据格式' };
      return withStorageLock(async () => {
        const res = await getStorage([STORAGE_KEYS.LOCAL_BLACKLIST, STORAGE_KEYS.WHITELIST]);
        const mergedWhitelist = normalizeList([
          ...(res[STORAGE_KEYS.WHITELIST] || []),
          ...(Array.isArray(data.whitelist) ? data.whitelist : []),
        ]);
        const wlSet = new Set(mergedWhitelist);
        const mergedLocalBl = normalizeList([
          ...(res[STORAGE_KEYS.LOCAL_BLACKLIST] || []),
          ...(Array.isArray(data.localBlacklist) ? data.localBlacklist : []),
        ]).filter((h) => !wlSet.has(h));
        await setStorage({
          [STORAGE_KEYS.LOCAL_BLACKLIST]: mergedLocalBl,
          [STORAGE_KEYS.WHITELIST]: mergedWhitelist,
        });
        return {
          ok: true,
          localBlacklistCount: mergedLocalBl.length,
          whitelistCount: mergedWhitelist.length,
        };
      });
    }

    async function getClientSnapshot() {
      await hydrateSessionCaches();
      const storage = await getStorage([
        STORAGE_KEYS.SETTINGS,
        STORAGE_KEYS.REMOTE_BLACKLIST,
        STORAGE_KEYS.LOCAL_BLACKLIST,
        STORAGE_KEYS.WHITELIST,
        STORAGE_KEYS.BLOCKED_TWEETS,
        STORAGE_KEYS.ALLOWED_TWEETS,
      ]);
      const lists = readNormalizedLists(storage);
      const now = Date.now();
      const validVerdictEntries = [];
      for (const [key, entry] of verdictCache.entries()) {
        if (entry && entry.value && Number(entry.expiresAt) > now) {
          validVerdictEntries.push([key, { expiresAt: entry.expiresAt, value: entry.value }]);
        } else {
          verdictCache.delete(key);
        }
      }
      return {
        settings: lists.settings,
        effectiveFlywheelUrl: getEffectiveFlywheelUrl(lists.settings),
        whitelist: lists.whitelist,
        remoteBlacklist: lists.remoteBlacklist,
        localBlacklist: lists.localBlacklist,
        blockedTweets: Array.from(lists.blockedTweetsSet),
        allowedTweets: Array.from(lists.allowedTweetsSet),
        sessionAccounts: Array.from(autoSessionAccounts),
        verdictCache: validVerdictEntries,
      };
    }

    async function recordLocalIntercepts(entries = []) {
      const list = Array.isArray(entries)
        ? entries.filter((e) => e && e.result && (e.result.tweetId || e.item?.tweetId))
        : [];
      if (list.length === 0) return { ok: true, newlyFiltered: 0 };

      return withStorageLock(async () => {
        const latest = await getStorage([
          STORAGE_KEYS.SETTINGS,
          STORAGE_KEYS.COUNTED_TWEETS,
          STORAGE_KEYS.RECENT_INTERCEPTED,
          STORAGE_KEYS.STATS,
        ]);
        const settings = normalizeSettings(latest[STORAGE_KEYS.SETTINGS] || {});
        if (!settings.enabled) return { ok: true, newlyFiltered: 0 };

        const outcome = applySlopInterceptionStats(latest, list);
        if (outcome.newlyFiltered > 0) {
          await setStorage({
            [STORAGE_KEYS.COUNTED_TWEETS]: outcome.trimmedCounted,
            [STORAGE_KEYS.RECENT_INTERCEPTED]: outcome.recentIntercepted,
            [STORAGE_KEYS.STATS]: outcome.stats,
          });
        }
        return { ok: true, newlyFiltered: outcome.newlyFiltered };
      });
    }

    async function getState() {
      const storage = await getStorage([
        STORAGE_KEYS.SETTINGS,
        STORAGE_KEYS.REMOTE_BLACKLIST,
        STORAGE_KEYS.LOCAL_BLACKLIST,
        STORAGE_KEYS.WHITELIST,
        STORAGE_KEYS.RECENT_INTERCEPTED,
        STORAGE_KEYS.STATS,
      ]);
      const lists = readNormalizedLists(storage);
      return {
        settings: lists.settings,
        effectiveFlywheelUrl: getEffectiveFlywheelUrl(lists.settings),
        blacklistCount: lists.blacklistSet.size,
        localBlacklist: lists.localBlacklist,
        remoteBlacklistCount: lists.remoteBlacklist.length,
        whitelist: lists.whitelist,
        recentIntercepted: Array.isArray(storage[STORAGE_KEYS.RECENT_INTERCEPTED])
          ? storage[STORAGE_KEYS.RECENT_INTERCEPTED]
          : [],
        stats: buildDefaultStats(storage[STORAGE_KEYS.STATS]),
      };
    }

    async function getDashboardData() {
      const storage = await getStorage([
        STORAGE_KEYS.SETTINGS,
        STORAGE_KEYS.REMOTE_BLACKLIST,
        STORAGE_KEYS.LOCAL_BLACKLIST,
        STORAGE_KEYS.WHITELIST,
        STORAGE_KEYS.RECENT_INTERCEPTED,
        STORAGE_KEYS.STATS,
      ]);
      const lists = readNormalizedLists(storage);
      const stats = buildDefaultStats(storage[STORAGE_KEYS.STATS]);

      return {
        settings: lists.settings,
        effectiveFlywheelUrl: getEffectiveFlywheelUrl(lists.settings),
        blacklistCount: lists.blacklistSet.size,
        effectiveBlacklist: Array.from(lists.blacklistSet).sort(),
        localBlacklist: lists.localBlacklist,
        remoteBlacklist: lists.remoteBlacklist,
        whitelist: lists.whitelist,
        accountInterceptCounts: stats.accountInterceptCounts || {},
        recentIntercepted: Array.isArray(storage[STORAGE_KEYS.RECENT_INTERCEPTED])
          ? storage[STORAGE_KEYS.RECENT_INTERCEPTED]
          : [],
        stats,
      };
    }

    async function markStageSeen({ stageId = '' } = {}) {
      const nextIdx = getBakuStageIndex(stageId);
      if (nextIdx < 0) {
        return { ok: false, error: 'Invalid stageId' };
      }
      return withStorageLock(async () => {
        const res = await getStorage([STORAGE_KEYS.STATS]);
        const stats = buildDefaultStats(res[STORAGE_KEYS.STATS]);
        const prevIdx = getBakuStageIndex(stats.lastSeenStageId);
        const updated = nextIdx > prevIdx;
        if (updated) {
          stats.lastSeenStageId = stageId;
          await setStorage({ [STORAGE_KEYS.STATS]: stats });
        }
        return { ok: true, lastSeenStageId: stats.lastSeenStageId, updated, stats };
      });
    }

    const MESSAGE_HANDLERS = {
      GET_STATE: () => getState(),
      GET_CLIENT_SNAPSHOT: () => getClientSnapshot(),
      GET_DASHBOARD_DATA: () => getDashboardData(),
      UPDATE_SETTINGS: (m) => updateSettings(m.settings || {}),
      SYNC_BLACKLIST: (m) => syncBlacklist({ full: Boolean(m.full), includeHealth: Boolean(m.includeHealth) }),
      REFRESH_HEALTH: () => refreshRemoteHealth(),
      CLASSIFY_BATCH: (m) => classifyBatch(m.items || []),
      RECORD_LOCAL_INTERCEPTS: (m) => recordLocalIntercepts(m.entries || []),
      REPORT_SLOP: (m) => reportSlop(m.payload || {}),
      UNBLOCK_ACCOUNT: (m) => unblockAccount(m.payload || {}),
      UNBLOCK_TWEET: (m) => unblockTweet(m.payload || {}),
      ALLOW_TWEET: (m) => allowTweet(m.payload || {}),
      UNDO_ALLOW_TWEET: (m) => undoAllowTweet(m.payload || {}),
      WHITELIST_ACCOUNT: (m) => whitelistAccount(m.payload || {}),
      UNDO_WHITELIST_ACCOUNT: (m) => undoWhitelistAccount(m.payload || {}),
      REMOVE_WHITELIST: (m) => removeWhitelist(m.handle),
      IMPORT_USER_DATA: (m) => importUserData(m.payload || {}),
      UPDATE_BADGE: (m, sender) => updateBadge(m, sender),
      MARK_STAGE_SEEN: (m) => markStageSeen(m.payload || m || {}),
    };

    function handleMessage(msg = {}, sender = null) {
      const handler = msg && MESSAGE_HANDLERS[msg.type];
      return handler
        ? Promise.resolve(handler(msg, sender))
        : Promise.resolve({ ok: false, error: 'Unknown message type' });
    }

    return {
      getState,
      getClientSnapshot,
      getDashboardData,
      updateSettings,
      syncBlacklist,
      refreshRemoteHealth,
      classifyBatch,
      recordLocalIntercepts,
      reportSlop,
      unblockAccount,
      unblockTweet,
      allowTweet,
      undoAllowTweet,
      whitelistAccount,
      undoWhitelistAccount,
      removeWhitelist,
      importUserData,
      markStageSeen,
      ensureSyncAlarm,
      clearSyncAlarm,
      reinjectOpenXTabs,
      syncAllToolbarAppearances,
      clearTabBadgeState,
      handleMessage,
    };
  }

  rootScope.AntiSlopBackground = {
    createBackgroundController,
    STORAGE_KEYS,
  };

  if (rootScope.chrome?.storage?.local && rootScope.chrome?.runtime?.onMessage) {
    const controller = createBackgroundController({
      chromeApi: rootScope.chrome,
      fetchImpl: (...args) => rootScope.fetch(...args),
    });

    if (rootScope.chrome.runtime.onInstalled) {
      rootScope.chrome.runtime.onInstalled.addListener(async (details) => {
        const { settings, effectiveFlywheelUrl } = await controller.getState();
        const nextSettings =
          details?.reason === 'update' && settings.syncIntervalMinutes === 5
            ? { ...settings, syncIntervalMinutes: 15 }
            : settings;
        await controller.updateSettings(nextSettings);
        await controller.syncAllToolbarAppearances(nextSettings);
        if (effectiveFlywheelUrl) await controller.ensureSyncAlarm(nextSettings.syncIntervalMinutes || 15);
        else await controller.clearSyncAlarm();
        await controller.reinjectOpenXTabs();
        controller.syncBlacklist();
      });
    }

    if (rootScope.chrome.runtime.onStartup) {
      rootScope.chrome.runtime.onStartup.addListener(async () => {
        const { settings, effectiveFlywheelUrl } = await controller.getState();
        await controller.syncAllToolbarAppearances(settings);
        if (effectiveFlywheelUrl) await controller.ensureSyncAlarm(settings.syncIntervalMinutes || 15);
        else await controller.clearSyncAlarm();
        controller.syncBlacklist();
      });
    }

    if (rootScope.chrome.tabs?.onRemoved) {
      rootScope.chrome.tabs.onRemoved.addListener((tabId) => {
        controller.clearTabBadgeState(tabId);
      });
    }

    if (rootScope.chrome.alarms?.onAlarm) {
      rootScope.chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === 'antislop_sync') controller.syncBlacklist();
      });
    }

    rootScope.chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      controller.handleMessage(msg, sender).then(sendResponse);
      return true;
    });
  }
})(typeof self !== 'undefined' ? self : globalThis);

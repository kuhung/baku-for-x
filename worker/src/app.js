import { FlywheelStore, isCacheableTweetId, normalizeHandle } from './flywheelStore.js';
import { createAiVerifierFromEnv } from './aiVerifier.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

async function readJsonBody(request, maxBytes = 256 * 1024) {
  const raw = await request.text();
  if (raw.length > maxBytes) {
    const err = new Error('Payload too large');
    err.status = 413;
    throw err;
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Invalid JSON body');
    err.status = 400;
    throw err;
  }
}

function getEdgeCache() {
  try {
    if (typeof caches !== 'undefined' && caches?.default) {
      return caches.default;
    }
  } catch {
    // ignore outside Workers runtime
  }
  return null;
}

function invalidateBlacklistEdgeCache(requestUrl, ctx) {
  const cache = getEdgeCache();
  if (!cache) return Promise.resolve();
  try {
    const baseKey = new Request(new URL('/api/v1/blacklist', requestUrl).toString(), { method: 'GET' });
    const p = cache.delete(baseKey).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
    return p;
  } catch {
    return Promise.resolve();
  }
}

function extractClientIp(request) {
  const cfIp = request.headers.get('cf-connecting-ip');
  if (cfIp && cfIp.trim()) return cfIp.trim();
  const xff = request.headers.get('x-forwarded-for');
  if (xff && xff.trim()) return xff.split(',')[0].trim();
  const realIp = request.headers.get('x-real-ip');
  if (realIp && realIp.trim()) return realIp.trim();
  return 'unknown';
}

async function hashClientIp(ip, salt = 'anti-slop-v1') {
  const raw = `${salt}:${ip || 'unknown'}`;
  if (globalThis.crypto?.subtle?.digest) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    const bytes = new Uint8Array(buf);
    let hex = '';
    for (let i = 0; i < 8; i += 1) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function sanitizeBatchItem(item = {}) {
  const handle = normalizeHandle(item.handle || '');
  const retweeterHandle = normalizeHandle(item.retweeterHandle || '');
  const quotedHandle = normalizeHandle(item.quotedHandle || '');
  const parentHandle = normalizeHandle(item.parentHandle || '');
  return {
    tweetId: item.tweetId ? String(item.tweetId).trim().slice(0, 128) : null,
    handle,
    retweeterHandle,
    quotedHandle,
    parentHandle,
    parentText: typeof item.parentText === 'string' ? item.parentText.slice(0, 240) : '',
    displayName: typeof item.displayName === 'string' ? item.displayName.slice(0, 120) : '',
    text: typeof item.text === 'string' ? item.text.slice(0, 500) : '',
    quotedText: typeof item.quotedText === 'string' ? item.quotedText.slice(0, 350) : '',
    isReply: Boolean(item.isReply),
    isRetweet: Boolean(item.isRetweet),
    isVerified: Boolean(item.isVerified),
  };
}

export function createFlywheelApp(options = {}) {
  const storeCache = new WeakMap();
  const minuteBuckets = new Map();

  function getStore(env = {}) {
    if (options.store) return options.store;
    const db = options.db || env.DB;
    if (!db) throw new Error('Missing D1 database binding (env.DB)');
    let store = storeCache.get(db);
    if (!store) {
      store = new FlywheelStore(db, {
        reportQuorum: options.reportQuorum ?? env.BLACKLIST_REPORT_QUORUM ?? 2,
        postReportQuorum: options.postReportQuorum ?? env.POST_REPORT_QUORUM ?? 2,
        escalationThreshold: options.escalationThreshold ?? env.ACCOUNT_ESCALATION_THRESHOLD ?? 3,
        aiDailyItemLimit: options.aiDailyItemLimit ?? env.AI_DAILY_ITEM_LIMIT ?? 5000,
        ipDailyItemLimit: options.ipDailyItemLimit ?? env.IP_DAILY_ITEM_LIMIT ?? 800,
        maxSamples: options.maxSamples ?? env.MAX_FLYWHEEL_SAMPLES ?? 5000,
        maxPostDecisions: options.maxPostDecisions ?? env.MAX_POST_DECISIONS ?? 20000,
        maxDecisionLogs: options.maxDecisionLogs ?? env.MAX_DECISION_LOGS ?? 1000,
        autoInitSchema: String(options.skipRuntimeSchemaInit ?? env.SKIP_RUNTIME_SCHEMA_INIT ?? '').toLowerCase() !== 'true',
        statsCacheTtlMs: options.statsCacheTtlMs ?? env.STATS_CACHE_TTL_MS ?? 60000,
      });
      storeCache.set(db, store);
    }
    return store;
  }

  function getVerifier(env = {}) {
    return options.aiVerifier ?? createAiVerifierFromEnv(env);
  }

  function checkAndConsumeMinuteLimit(ipHash, itemCount, env = {}) {
    if (!ipHash || ipHash === 'trusted' || itemCount <= 0) return true;
    const rawLimit = Number(options.ipMinuteItemLimit ?? env.IP_MINUTE_ITEM_LIMIT ?? 120);
    const limit = Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 120);
    const now = Date.now();
    const cutoff = now - 60_000;

    if (minuteBuckets.size > 2000) {
      for (const [key, entries] of minuteBuckets.entries()) {
        const active = entries.filter((e) => e.ts > cutoff);
        if (active.length === 0) minuteBuckets.delete(key);
        else minuteBuckets.set(key, active);
      }
    }

    const active = (minuteBuckets.get(ipHash) || []).filter((e) => e.ts > cutoff);
    const used = active.reduce((sum, e) => sum + e.count, 0);
    if (used + itemCount > limit) {
      if (active.length === 0) minuteBuckets.delete(ipHash);
      else minuteBuckets.set(ipHash, active);
      return false;
    }

    active.push({ ts: now, count: itemCount });
    minuteBuckets.set(ipHash, active);
    return true;
  }

  async function handleRequest(request, env = {}, ctx = null) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const apiAuthToken = String(options.apiAuthToken ?? env.API_AUTH_TOKEN ?? '').trim();
    const authHeader = request.headers.get('authorization') || '';
    const isAuthorized = Boolean(apiAuthToken && authHeader === `Bearer ${apiAuthToken}`);
    if (apiAuthToken && !isAuthorized) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      const store = getStore(env);
      const aiVerifier = getVerifier(env);

      if (request.method === 'GET' && pathname === '/health') {
        const stats = await store.getStats();
        return jsonResponse(
          {
            ok: true,
            service: 'anti-slop-flywheel',
            aiConfigured: aiVerifier.isConfigured(),
            aiProvider: aiVerifier.isConfigured() ? aiVerifier.provider : null,
            ...stats,
            timestamp: new Date().toISOString(),
          },
          200,
          !apiAuthToken ? { 'Cache-Control': 'public, max-age=60' } : {}
        );
      }

      if (request.method === 'GET' && pathname === '/api/v1/stats') {
        const stats = await store.getStats();
        return jsonResponse(
          { ok: true, ...stats },
          200,
          !apiAuthToken ? { 'Cache-Control': 'public, max-age=60' } : {}
        );
      }

      if (request.method === 'GET' && pathname === '/api/v1/blacklist') {
        const since = url.searchParams.get('since');
        const sinceVersion = url.searchParams.get('sinceVersion');
        const cache = !apiAuthToken && !since && !sinceVersion ? getEdgeCache() : null;

        if (cache) {
          const cached = await cache.match(request);
          if (cached) return cached;
        }

        const data = await store.getBlacklist({ since, sinceVersion });
        const resp = jsonResponse(data, 200, !since && !sinceVersion ? { 'Cache-Control': 'public, max-age=60' } : {});
        if (cache) {
          const putPromise = cache.put(request, resp.clone()).catch(() => {});
          if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(putPromise);
        }
        return resp;
      }

      if (request.method === 'POST' && pathname === '/api/v1/signal') {
        const body = await readJsonBody(request);
        const ipHash = isAuthorized ? 'trusted' : await hashClientIp(extractClientIp(request), env.IP_HASH_SALT || 'anti-slop-v1');
        const result = await store.recordSignal(body, {
          aiVerifier,
          ipHash,
          deferTask: ctx && typeof ctx.waitUntil === 'function' ? (p) => ctx.waitUntil(p) : null,
          onBlacklistChange: () => invalidateBlacklistEdgeCache(url, ctx),
        });
        if (!result.ok) {
          return jsonResponse(result, 400);
        }
        return jsonResponse(result, 200);
      }

      if (request.method === 'POST' && pathname === '/api/v1/classify/batch') {
        const allowPublic = String(options.allowPublicClassify ?? env.ALLOW_PUBLIC_CLASSIFY ?? 'true').toLowerCase() !== 'false';
        if (!isAuthorized && !allowPublic) {
          return jsonResponse({ error: 'Public batch classify is disabled; use blacklist sync or BYOK' }, 403);
        }

        const body = await readJsonBody(request);
        if (!Array.isArray(body.items)) {
          return jsonResponse({ error: 'items must be an array' }, 400);
        }

        const items = body.items.slice(0, 25).map(sanitizeBatchItem);
        const whitelistSet = new Set(
          (Array.isArray(body.whitelist) ? body.whitelist : []).map(normalizeHandle).filter(Boolean)
        );

        const finalResults = new Array(items.length);
        const afterWhitelist = [];
        const allCandidateHandles = [];

        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          if (item.handle && whitelistSet.has(item.handle)) {
            finalResults[i] = {
              tweetId: item.tweetId,
              handle: item.handle,
              matchedHandle: item.handle,
              verdict: 'ALLOW',
              scope: 'TWEET',
              confidence: 1,
              source: 'whitelist',
              reason: 'Account in whitelist',
            };
            continue;
          }
          const candidates = [item.handle, item.retweeterHandle, item.quotedHandle].filter((h) => h && !whitelistSet.has(h));
          for (const h of candidates) allCandidateHandles.push(h);
          afterWhitelist.push({ idx: i, item, candidates });
        }

        const blMap = await store.findBlacklistedMap(allCandidateHandles);
        const afterBlacklist = [];
        const cacheableIds = [];

        for (const entry of afterWhitelist) {
          let blHit = null;
          for (const c of entry.candidates) {
            if (blMap.has(c)) {
              blHit = blMap.get(c);
              break;
            }
          }
          if (blHit) {
            finalResults[entry.idx] = {
              tweetId: entry.item.tweetId,
              handle: entry.item.handle,
              matchedHandle: blHit.handle,
              verdict: 'SLOP',
              scope: 'ACCOUNT',
              confidence: 1,
              source: 'blacklist',
              reason: `Shared blacklist (@${blHit.handle}: ${blHit.reason})`,
            };
            continue;
          }
          if (entry.item.tweetId && isCacheableTweetId(entry.item.tweetId, entry.item.handle)) {
            cacheableIds.push(entry.item.tweetId);
          }
          afterBlacklist.push(entry);
        }

        const cachedPostMap = await store.findPostDecisions(cacheableIds);
        const aiPending = [];

        for (const entry of afterBlacklist) {
          const cached = entry.item.tweetId ? cachedPostMap.get(entry.item.tweetId) : null;
          if (cached) {
            finalResults[entry.idx] = {
              tweetId: entry.item.tweetId,
              handle: entry.item.handle,
              matchedHandle: cached.handle || entry.item.handle,
              verdict: cached.verdict === 'SLOP' ? 'SLOP' : 'ALLOW',
              scope: 'TWEET',
              confidence: Number(cached.confidence || 0),
              source: 'post_cache',
              reason: cached.reason || 'Cached post decision',
            };
            continue;
          }
          aiPending.push(entry);
        }

        if (aiPending.length > 0) {
          if (!aiVerifier.isConfigured()) {
            for (const entry of aiPending) {
              finalResults[entry.idx] = {
                tweetId: entry.item.tweetId,
                handle: entry.item.handle,
                matchedHandle: entry.item.handle,
                verdict: 'ALLOW',
                scope: 'TWEET',
                confidence: 0,
                source: 'ai_unconfigured',
                reason: 'AI not configured',
              };
            }
          } else {
            const ipHash = isAuthorized
              ? 'trusted'
              : await hashClientIp(extractClientIp(request), env.IP_HASH_SALT || 'anti-slop-v1');
            const minuteOk = checkAndConsumeMinuteLimit(ipHash, aiPending.length, env);
            const quota = minuteOk ? await store.consumeAiQuota({ ipHash, itemCount: aiPending.length }) : { allowed: false, reason: 'IP_MINUTE_LIMIT' };

            if (!quota.allowed) {
              for (const entry of aiPending) {
                finalResults[entry.idx] = {
                  tweetId: entry.item.tweetId,
                  handle: entry.item.handle,
                  matchedHandle: entry.item.handle,
                  verdict: 'ALLOW',
                  scope: 'TWEET',
                  confidence: 0,
                  source: 'rate_limited_allow',
                  reason: quota.reason || 'Rate limit exceeded',
                };
              }
            } else {
              const aiResults = await aiVerifier.classifyTweetsBatch(aiPending.map((p) => p.item));
              const toSave = [];
              const logsToAppend = [];

              for (let j = 0; j < aiPending.length; j += 1) {
                const entry = aiPending[j];
                const resItem = aiResults[j];
                finalResults[entry.idx] = resItem;

                if (resItem && resItem.source === 'ai_model') {
                  const targetHandle = normalizeHandle(resItem.matchedHandle || entry.item.handle);
                  const probNum = Number(
                    resItem.slopProb ??
                      (resItem.verdict === 'SLOP' ? resItem.confidence : 1 - (resItem.confidence || 0.5))
                  );
                  const preview = String(entry.item.text || entry.item.quotedText || '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 90);
                  console.log(
                    `[classify] ${resItem.verdict} p=${probNum.toFixed(3)} [reply=${entry.item.isReply ? 1 : 0} blue=${entry.item.isVerified ? 1 : 0}] @${targetHandle || entry.item.handle || 'unknown'} (${entry.item.tweetId || '-'}): ${preview}`
                  );

                  logsToAppend.push({
                    tweetId: entry.item.tweetId || '',
                    handle: targetHandle || entry.item.handle || '',
                    isReply: entry.item.isReply,
                    isVerified: entry.item.isVerified,
                    verdict: resItem.verdict,
                    slopProb: probNum,
                    confidence: resItem.confidence || 0,
                    text: entry.item.text || '',
                    quotedText: entry.item.quotedText || '',
                    parentText: entry.item.parentText || '',
                  });

                  if (entry.item.tweetId && isCacheableTweetId(entry.item.tweetId, targetHandle)) {
                    toSave.push({
                      tweetId: entry.item.tweetId,
                      handle: targetHandle,
                      verdict: resItem.verdict,
                      confidence: resItem.confidence || 0,
                      source: 'ai_model',
                      reason: resItem.reason || '',
                    });
                  }
                }
              }

              if (toSave.length > 0 || logsToAppend.length > 0) {
                const persistPromise = Promise.all([
                  toSave.length > 0
                    ? store.savePostDecisions(toSave).then(({ escalatedHandles }) => {
                        if (escalatedHandles.length > 0) {
                          return invalidateBlacklistEdgeCache(url, ctx);
                        }
                        return null;
                      })
                    : null,
                  logsToAppend.length > 0 ? store.appendDecisionLogs(logsToAppend) : null,
                ]).catch(() => {});

                if (ctx && typeof ctx.waitUntil === 'function') {
                  ctx.waitUntil(persistPromise);
                } else {
                  await persistPromise;
                }
              }
            }
          }
        }

        return jsonResponse({ results: finalResults });
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      const status = err.status || 500;
      return jsonResponse({ error: err.message || 'Internal server error' }, status);
    }
  }

  return { handleRequest, getStore, getVerifier };
}

const defaultApp = createFlywheelApp();

export function handleFlywheelRequest(request, env, ctx) {
  return defaultApp.handleRequest(request, env, ctx);
}

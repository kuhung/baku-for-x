# 静貘 · Baku 飞轮后端协议规范（Flywheel API Specification）

Both the Cloudflare Worker (`worker/src/index.js`) and the local Node adapter (`server/src/index.js`) run the exact same HTTP handler (`worker/src/app.js`) over D1 / `node:sqlite`. Service identifiers (`anti-slop-flywheel`) remain unchanged for backward compatibility with existing deployments.

All endpoints accept and return `application/json` with CORS enabled. When `API_AUTH_TOKEN` is configured, requests must include `Authorization: Bearer <token>`. On public deployments (`API_AUTH_TOKEN` unset), passwordless anti-abuse protection applies automatically via deduplicated post/account caching, SHA-256 IP rate limits, and a daily global AI item cap.

---

## 1. Health & Stats

### `GET /health`
Returns service readiness, AI verifier availability, daily AI usage, quorum/escalation thresholds, and active counts.

Counts are served in `O(1)` from the trigger-maintained `flywheel_counters` single-row table with a 60-second in-memory cache (invalidated immediately on writes) and `Cache-Control: public, max-age=60` on public deployments. The extension requests `/health` on-demand when opening or manually syncing the dashboard cloud tab rather than on background timer polls.

**Response `200 OK`:**
```json
{
  "ok": true,
  "service": "anti-slop-flywheel",
  "aiConfigured": true,
  "aiProvider": "gemini_decisions",
  "blacklistCount": 42,
  "blacklistVersion": 57,
  "slopPostCount": 318,
  "cachedPostCount": 1420,
  "sampleCount": 128,
  "todayAiCalls": 19,
  "todayAiItems": 240,
  "aiDailyItemLimit": 5000,
  "reportQuorum": 2,
  "escalationThreshold": 3,
  "timestamp": "2026-11-19T09:00:00.000Z"
}
```

### `GET /api/v1/stats`
Returns aggregated flywheel counts from `flywheel_counters` (with the same 60-second in-memory and `Cache-Control: public, max-age=60` cache) without health metadata.

---

## 2. Incremental Shared Blacklist Sync (L2)

### `GET /api/v1/blacklist`
Returns active shared blacklist accounts and incremental deltas. Uses index-backed metadata lookups (`version`, `updated_at`) and short-circuits delta row queries when `sinceVersion >= currentVersion`.

Query parameters (optional):
- `sinceVersion=<integer>`: recommended monotonic cursor. Returns only rows changed after `<integer>`, split into active additions/updates (`accounts`) and deactivated/appealed handles (`removed`).
- `since=<ISO timestamp>`: timestamp cursor fallback.

---

## 3. Two-Tier Batch Classification (L1 Posts + L2 Blacklist)

### `POST /api/v1/classify/batch`
Evaluates up to 25 items per request in order:
1. Client `whitelist` -> `ALLOW (source: "whitelist")`
2. Bulk L2 `blacklist` check (outer, retweeter, quoted handles) -> `SLOP (scope: "ACCOUNT", source: "blacklist")`
3. Bulk L1 `post_decisions` cache lookup -> cached `SLOP` / `ALLOW (scope: "TWEET", source: "post_cache", slopProb)`
4. Unseen posts -> rate-limit & daily budget check -> `AiVerifier.classifyTweetsBatch` (single Gemini `gemini-decision-1` request for all pending items, zero output tokens) -> persisted asynchronously into `post_decisions` (preserving `slop_prob`).

When an account accumulates `ACCOUNT_ESCALATION_THRESHOLD` (default `3`) distinct `SLOP` posts in `post_decisions` (net of appeals), it automatically escalates into the shared L2 `blacklist` (`source: "post_escalation"`).

If `ALLOW_PUBLIC_CLASSIFY=false` and `API_AUTH_TOKEN` is unmatched, returns `403 Forbidden`. When `API_AUTH_TOKEN` is unset and quotas are exceeded, degrades gracefully to `ALLOW (source: "rate_limited_allow")`.

---

## 4. Silent Flywheel Signals (L1 & L2)

### `POST /api/v1/signal`
Records explicit user feedback signals emitted silently by the extension, persisting context (`quotedHandle`, `parentHandle`, `parentText`, `isReply`, `isVerified`) and any prior AI snapshot (`origVerdict`, `origSlopProb`, `origSource`) into `flywheel_samples` without overwriting the cached `slop_prob` in `post_decisions`. Expensive AI verification runs inside `ctx.waitUntil` on Cloudflare Workers so responses return immediately.

**Supported `type` values:**
- `BLOCK_TWEET` (L1): stores `FN_TWEET` sample and `(tweetId, clientId)` `REPORT` vote. Marks `post_decisions` as `SLOP` via quorum (`POST_REPORT_QUORUM`) or single-shot Gemini Decision verification, and checks L1 -> L2 escalation.
- `APPEAL_TWEET` (L1): stores `FP_TWEET` sample and `APPEAL` vote; immediately flips `post_decisions` to `ALLOW (source: "appealed")` when `appealCount >= 1` and net votes fall below quorum.
- `BLOCK_ACCOUNT` (L2): records `(handle, clientId)` `REPORT` vote and `FN_ACCOUNT` sample.
  - Promotes to `blacklist` immediately on `BLACKLIST_REPORT_QUORUM` (counting `reportCount - 2 * appealCount`).
  - Otherwise aggregates up to 5 recent `flywheel_samples` for the handle and calls `gemini-decision-1` (`verifyAccountCandidate`). Dedicated slop accounts promote (`source: "ai_verified"`); occasional noisy tweets from ordinary authors are downgraded to L1 `post_decisions` only (`postSlop: true`).
- `UNBLOCK_ACCOUNT` (L2): revokes the reporter's `REPORT` vote and deactivates `blacklist` if reports drop to 0 or net votes fall below quorum.
- `APPEAL_ACCOUNT` (L2): records `APPEAL` vote and `FP_ACCOUNT` sample. Following an innocence-presumption rule:
  - 1 `APPEAL_ACCOUNT` immediately deactivates `ai_verified` or `post_escalation` entries back to L1 post-level filtering;
  - `quorum` entries deactivate whenever `reportCount - 2 * appealCount < BLACKLIST_REPORT_QUORUM`.

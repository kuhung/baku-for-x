export const VALID_HANDLE_RE = /^[a-z0-9_]{1,30}$/;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS post_decisions (
    tweet_id TEXT PRIMARY KEY,
    handle TEXT NOT NULL DEFAULT '',
    verdict TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'ai_model',
    reason TEXT NOT NULL DEFAULT '',
    report_count INTEGER NOT NULL DEFAULT 0,
    appeal_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_post_decisions_handle ON post_decisions(handle, verdict)`,
  `CREATE INDEX IF NOT EXISTS idx_post_decisions_updated ON post_decisions(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_post_decisions_prune
    ON post_decisions(updated_at)
    WHERE verdict = 'ALLOW' AND source != 'appealed'`,
  `CREATE TABLE IF NOT EXISTS post_votes (
    tweet_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    vote_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tweet_id, client_id)
  )`,
  `CREATE TABLE IF NOT EXISTS blacklist (
    handle TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT 'USER_REPORT',
    source TEXT NOT NULL DEFAULT 'quorum',
    report_count INTEGER NOT NULL DEFAULT 1,
    fp_count INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blacklist_updated ON blacklist(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_blacklist_version ON blacklist(version)`,
  `CREATE TABLE IF NOT EXISTS signal_votes (
    handle TEXT NOT NULL,
    client_id TEXT NOT NULL,
    vote_type TEXT NOT NULL,
    sample_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (handle, client_id)
  )`,
  `CREATE TABLE IF NOT EXISTS flywheel_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_type TEXT NOT NULL,
    handle TEXT NOT NULL DEFAULT '',
    tweet_id TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    quoted_text TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    client_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (client_id, signal_type, handle, tweet_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_samples_handle ON flywheel_samples(handle, id DESC)`,
  `CREATE TABLE IF NOT EXISTS ai_verifications (
    handle TEXT PRIMARY KEY,
    verdict TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    verify_count INTEGER NOT NULL DEFAULT 1,
    sample_count INTEGER NOT NULL DEFAULT 0,
    verified_day TEXT NOT NULL,
    verified_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_verifications_day ON ai_verifications(verified_day)`,
  `CREATE TABLE IF NOT EXISTS ai_usage_daily (
    usage_day TEXT PRIMARY KEY,
    call_count INTEGER NOT NULL DEFAULT 0,
    item_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS ip_daily_usage (
    usage_day TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    item_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (usage_day, ip_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS decision_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id TEXT NOT NULL DEFAULT '',
    handle TEXT NOT NULL DEFAULT '',
    is_reply INTEGER NOT NULL DEFAULT 0,
    is_verified INTEGER NOT NULL DEFAULT 0,
    verdict TEXT NOT NULL,
    slop_prob REAL NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0,
    text_excerpt TEXT NOT NULL DEFAULT '',
    parent_excerpt TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_decision_logs_created ON decision_logs(id DESC)`,
  `CREATE TABLE IF NOT EXISTS flywheel_counters (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active_blacklist_count INTEGER NOT NULL DEFAULT 0,
    blacklist_version INTEGER NOT NULL DEFAULT 0,
    cached_post_count INTEGER NOT NULL DEFAULT 0,
    slop_post_count INTEGER NOT NULL DEFAULT 0,
    sample_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TRIGGER IF NOT EXISTS trg_post_decisions_ai AFTER INSERT ON post_decisions
   BEGIN
     UPDATE flywheel_counters
     SET cached_post_count = cached_post_count + 1,
         slop_post_count = slop_post_count + CASE WHEN NEW.verdict = 'SLOP' THEN 1 ELSE 0 END
     WHERE id = 1;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_post_decisions_au AFTER UPDATE OF verdict ON post_decisions
   WHEN OLD.verdict != NEW.verdict
   BEGIN
     UPDATE flywheel_counters
     SET slop_post_count = MAX(0, slop_post_count + CASE WHEN NEW.verdict = 'SLOP' THEN 1 ELSE -1 END)
     WHERE id = 1;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_post_decisions_ad AFTER DELETE ON post_decisions
   BEGIN
     UPDATE flywheel_counters
     SET cached_post_count = MAX(0, cached_post_count - 1),
         slop_post_count = MAX(0, slop_post_count - CASE WHEN OLD.verdict = 'SLOP' THEN 1 ELSE 0 END)
     WHERE id = 1;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_blacklist_ai AFTER INSERT ON blacklist
   BEGIN
     UPDATE flywheel_counters
     SET active_blacklist_count = active_blacklist_count + CASE WHEN NEW.active = 1 THEN 1 ELSE 0 END,
         blacklist_version = MAX(blacklist_version, NEW.version)
     WHERE id = 1;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_blacklist_au AFTER UPDATE OF active, version ON blacklist
   WHEN OLD.active != NEW.active OR OLD.version != NEW.version
   BEGIN
     UPDATE flywheel_counters
     SET active_blacklist_count = MAX(0, active_blacklist_count + (CASE WHEN NEW.active = 1 THEN 1 ELSE 0 END) - (CASE WHEN OLD.active = 1 THEN 1 ELSE 0 END)),
         blacklist_version = MAX(blacklist_version, NEW.version)
     WHERE id = 1;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_blacklist_ad AFTER DELETE ON blacklist
   BEGIN
     UPDATE flywheel_counters
     SET active_blacklist_count = MAX(0, active_blacklist_count - CASE WHEN OLD.active = 1 THEN 1 ELSE 0 END)
     WHERE id = 1;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_flywheel_samples_ai AFTER INSERT ON flywheel_samples
   BEGIN
     UPDATE flywheel_counters
     SET sample_count = sample_count + 1
     WHERE id = 1;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_flywheel_samples_ad AFTER DELETE ON flywheel_samples
   BEGIN
     UPDATE flywheel_counters
     SET sample_count = MAX(0, sample_count - 1)
     WHERE id = 1;
   END`,
];

export function normalizeHandle(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const cleaned = raw.trim().replace(/^@+/, '').toLowerCase();
  return VALID_HANDLE_RE.test(cleaned) ? cleaned : '';
}

export function isCacheableTweetId(raw, handle = '') {
  if (typeof raw !== 'string') return false;
  const id = raw.trim();
  if (id.length < 2 || id.length > 128) return false;
  if (id.startsWith('acct_')) return false;
  if (/^\d{5,25}$/.test(id)) return true;
  if (id.startsWith('dom_')) {
    const norm = normalizeHandle(handle);
    if (norm && id.toLowerCase() === `dom_${norm}`) return false;
    return /^dom_[a-z0-9_]+_[a-z0-9]{4,}$/i.test(id);
  }
  return true;
}

function sanitizeClientId(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s ? s.slice(0, 128) : 'anonymous';
}

function sanitizeText(raw, maxLen = 600) {
  return typeof raw === 'string' ? raw.trim().slice(0, maxLen) : '';
}

function parseIntOption(val, fallback, min = 0) {
  const num = Number(val ?? fallback);
  return Math.max(min, Number.isFinite(num) ? Math.floor(num) : fallback);
}

export class FlywheelStore {
  constructor(db, options = {}) {
    if (!db) throw new Error('D1/SQLite db instance is required');
    this.db = db;
    this.reportQuorum = parseIntOption(options.reportQuorum, 2, 1);
    this.postReportQuorum = parseIntOption(options.postReportQuorum, 2, 1);
    this.escalationThreshold = parseIntOption(options.escalationThreshold, 3, 1);
    this.aiDailyItemLimit = parseIntOption(options.aiDailyItemLimit, 5000, 0);
    this.ipDailyItemLimit = parseIntOption(options.ipDailyItemLimit, 800, 0);
    this.maxSamples = parseIntOption(options.maxSamples, 5000, 100);
    this.maxPostDecisions = parseIntOption(options.maxPostDecisions, 20000, 100);
    this.maxDecisionLogs = parseIntOption(options.maxDecisionLogs, 1000, 50);
    this.autoInitSchema = options.autoInitSchema !== false;
    this.statsCacheTtlMs = parseIntOption(options.statsCacheTtlMs, 60000, 0);
    this._statsCache = null;
    this._schemaPromise = null;
  }

  _invalidateStatsCache() {
    this._statsCache = null;
  }

  async _ensureCountersRow() {
    const existing = await this.db.prepare('SELECT id FROM flywheel_counters WHERE id = 1').first();
    if (existing) return;
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO flywheel_counters (
           id, active_blacklist_count, blacklist_version, cached_post_count, slop_post_count, sample_count
         )
         VALUES (
           1,
           (SELECT COUNT(*) FROM blacklist WHERE active = 1),
           (SELECT COALESCE(MAX(version), 0) FROM blacklist),
           (SELECT COUNT(*) FROM post_decisions),
           (SELECT COUNT(*) FROM post_decisions WHERE verdict = 'SLOP'),
           (SELECT COUNT(*) FROM flywheel_samples)
         )`
      )
      .run();
  }

  async ensureSchema() {
    if (!this.autoInitSchema) return;
    if (!this._schemaPromise) {
      this._schemaPromise = this.db
        .batch(SCHEMA_STATEMENTS.map((sql) => this.db.prepare(sql)))
        .then(() => this._ensureCountersRow())
        .catch((err) => {
          this._schemaPromise = null;
          throw err;
        });
    }
    return this._schemaPromise;
  }

  async _countVotes(table, keyCol, keyVal) {
    const res = await this.db
      .prepare(`SELECT vote_type, COUNT(*) AS cnt FROM ${table} WHERE ${keyCol} = ? GROUP BY vote_type`)
      .bind(keyVal)
      .all();
    let reportCount = 0;
    let appealCount = 0;
    for (const row of res?.results || []) {
      if (row.vote_type === 'REPORT') reportCount = Number(row.cnt || 0);
      else if (row.vote_type === 'APPEAL') appealCount = Number(row.cnt || 0);
    }
    return { reportCount, appealCount };
  }

  async _getVoteCounts(handle) {
    return this._countVotes('signal_votes', 'handle', handle);
  }

  async _getPostVoteCounts(tweetId) {
    return this._countVotes('post_votes', 'tweet_id', tweetId);
  }

  async _getBlacklistRow(handle) {
    return this.db
      .prepare('SELECT handle, reason, source, report_count, fp_count, active, version, added_at, updated_at FROM blacklist WHERE handle = ?')
      .bind(handle)
      .first();
  }

  async _nextBlacklistVersion() {
    const row = await this.db.prepare('SELECT COALESCE(MAX(version), 0) AS maxVer FROM blacklist').first();
    return Number(row?.maxVer || 0) + 1;
  }

  async _readCounterRow() {
    let row = await this.db
      .prepare(
        'SELECT active_blacklist_count, blacklist_version, cached_post_count, slop_post_count, sample_count FROM flywheel_counters WHERE id = 1'
      )
      .first();
    if (!row) {
      await this._ensureCountersRow();
      row = await this.db
        .prepare(
          'SELECT active_blacklist_count, blacklist_version, cached_post_count, slop_post_count, sample_count FROM flywheel_counters WHERE id = 1'
        )
        .first();
    }
    return row || {};
  }

  async _activateBlacklist(handle, { reason, source, reportCount, fpCount, now }) {
    const nextVer = await this._nextBlacklistVersion();
    await this.db
      .prepare(
        `INSERT INTO blacklist (handle, reason, source, report_count, fp_count, active, version, added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET
           reason = excluded.reason,
           source = excluded.source,
           report_count = excluded.report_count,
           fp_count = excluded.fp_count,
           active = 1,
           version = excluded.version,
           updated_at = excluded.updated_at`
      )
      .bind(handle, sanitizeText(reason, 200) || 'USER_REPORT', source, reportCount, fpCount, nextVer, now, now)
      .run();
    this._invalidateStatsCache();
  }

  async _deactivateBlacklist(handle, { reportCount, fpCount, now }) {
    const nextVer = await this._nextBlacklistVersion();
    await this.db
      .prepare(
        `UPDATE blacklist
         SET active = 0, report_count = ?, fp_count = ?, version = ?, updated_at = ?
         WHERE handle = ?`
      )
      .bind(reportCount, fpCount, nextVer, now, handle)
      .run();
    this._invalidateStatsCache();
  }

  async _insertSample({ signalType, handle = '', tweetId = '', displayName = '', text = '', quotedText = '', reason = '', clientId, now }) {
    await this.db
      .prepare(
        `INSERT INTO flywheel_samples (signal_type, handle, tweet_id, display_name, text, quoted_text, reason, client_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_id, signal_type, handle, tweet_id) DO UPDATE SET
           display_name = excluded.display_name,
           text = excluded.text,
           quoted_text = excluded.quoted_text,
           reason = excluded.reason,
           created_at = excluded.created_at`
      )
      .bind(
        signalType,
        handle,
        tweetId ? String(tweetId).slice(0, 128) : '',
        sanitizeText(displayName, 120),
        sanitizeText(text, 800),
        sanitizeText(quotedText, 400),
        sanitizeText(reason, 200),
        clientId,
        now
      )
      .run();

    const counterRow = await this._readCounterRow();
    const sampleCount = Number(counterRow.sample_count || 0);
    if (sampleCount > this.maxSamples) {
      const excess = sampleCount - this.maxSamples;
      await this.db
        .prepare(
          `DELETE FROM flywheel_samples
           WHERE id IN (
             SELECT id FROM flywheel_samples ORDER BY id ASC LIMIT ?
           )`
        )
        .bind(excess)
        .run();
    }
    this._invalidateStatsCache();
  }

  /**
   * Enforce global daily and per-IP daily AI evaluation budgets.
   */
  async consumeAiQuota({ ipHash = '', itemCount = 1 } = {}) {
    await this.ensureSchema();
    const count = Math.max(0, Math.floor(Number(itemCount) || 0));
    if (count === 0) return { allowed: true };

    const today = new Date().toISOString().slice(0, 10);
    const dayRow = await this.db
      .prepare('SELECT call_count, item_count FROM ai_usage_daily WHERE usage_day = ?')
      .bind(today)
      .first();
    const usedDayItems = Number(dayRow?.item_count || 0);
    if (usedDayItems + count > this.aiDailyItemLimit) {
      return { allowed: false, reason: 'DAILY_LIMIT', usedDayItems, limit: this.aiDailyItemLimit };
    }

    const trackIp = Boolean(ipHash && ipHash !== 'trusted');
    let isNewIpDay = false;
    if (trackIp) {
      const ipRow = await this.db
        .prepare('SELECT item_count FROM ip_daily_usage WHERE usage_day = ? AND ip_hash = ?')
        .bind(today, ipHash)
        .first();
      isNewIpDay = !ipRow;
      const usedIpItems = Number(ipRow?.item_count || 0);
      if (usedIpItems + count > this.ipDailyItemLimit) {
        return { allowed: false, reason: 'IP_DAILY_LIMIT', usedIpItems, limit: this.ipDailyItemLimit };
      }
    }

    const stmts = [
      this.db
        .prepare(
          `INSERT INTO ai_usage_daily (usage_day, call_count, item_count)
           VALUES (?, 1, ?)
           ON CONFLICT(usage_day) DO UPDATE SET
             call_count = ai_usage_daily.call_count + 1,
             item_count = ai_usage_daily.item_count + excluded.item_count`
        )
        .bind(today, count),
    ];

    if (trackIp) {
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO ip_daily_usage (usage_day, ip_hash, item_count)
             VALUES (?, ?, ?)
             ON CONFLICT(usage_day, ip_hash) DO UPDATE SET
               item_count = ip_daily_usage.item_count + excluded.item_count`
          )
          .bind(today, ipHash, count)
      );
      if (isNewIpDay) {
        stmts.push(this.db.prepare('DELETE FROM ip_daily_usage WHERE usage_day < ?').bind(today));
      }
    }

    await this.db.batch(stmts);
    this._invalidateStatsCache();
    return { allowed: true };
  }

  async findBlacklistedMap(handles = []) {
    await this.ensureSchema();
    const clean = [];
    for (const raw of handles) {
      const h = normalizeHandle(raw);
      if (h && !clean.includes(h)) clean.push(h);
    }
    const map = new Map();
    if (clean.length === 0) return map;

    const placeholders = clean.map(() => '?').join(', ');
    const res = await this.db
      .prepare(`SELECT handle, reason, source, report_count FROM blacklist WHERE active = 1 AND handle IN (${placeholders})`)
      .bind(...clean)
      .all();
    for (const row of res?.results || []) {
      map.set(row.handle, row);
    }
    return map;
  }

  /**
   * Look up cached L1 post decisions in bulk.
   */
  async findPostDecisions(tweetIds = []) {
    await this.ensureSchema();
    const clean = [];
    for (const raw of tweetIds) {
      const id = typeof raw === 'string' ? raw.trim() : '';
      if (id && isCacheableTweetId(id) && !clean.includes(id)) clean.push(id);
    }
    const map = new Map();
    if (clean.length === 0) return map;

    const placeholders = clean.map(() => '?').join(', ');
    const res = await this.db
      .prepare(
        `SELECT tweet_id, handle, verdict, confidence, source, reason, report_count, appeal_count, updated_at
         FROM post_decisions
         WHERE tweet_id IN (${placeholders})`
      )
      .bind(...clean)
      .all();
    for (const row of res?.results || []) {
      map.set(row.tweet_id, row);
    }
    return map;
  }

  async _checkAndEscalateAccount(handle, now = new Date().toISOString()) {
    const norm = normalizeHandle(handle);
    if (!norm) return false;

    const existing = await this._getBlacklistRow(norm);
    if (existing && Number(existing.active) === 1) return false;

    const slopRow = await this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM post_decisions WHERE handle = ? AND verdict = 'SLOP'`)
      .bind(norm)
      .first();
    const slopPostCount = Number(slopRow?.cnt || 0);
    if (slopPostCount < this.escalationThreshold) return false;

    const { reportCount, appealCount } = await this._getVoteCounts(norm);
    if (slopPostCount - 2 * appealCount < this.escalationThreshold) return false;

    await this._activateBlacklist(norm, {
      reason: `Repeated slop posts (${slopPostCount})`,
      source: 'post_escalation',
      reportCount: Math.max(reportCount, 1),
      fpCount: appealCount,
      now,
    });
    return true;
  }

  /**
   * Persist L1 post decisions and trigger L1 -> L2 escalation for repeat offenders.
   */
  async savePostDecisions(entries = []) {
    await this.ensureSchema();
    if (!Array.isArray(entries) || entries.length === 0) return { escalatedHandles: [] };

    const now = new Date().toISOString();
    const stmts = [];
    const slopHandles = new Set();

    for (const entry of entries) {
      if (!entry) continue;
      const tweetId = typeof entry.tweetId === 'string' ? entry.tweetId.trim() : '';
      const handle = normalizeHandle(entry.handle || '');
      if (!isCacheableTweetId(tweetId, handle)) continue;

      const verdict = String(entry.verdict || '').toUpperCase() === 'SLOP' ? 'SLOP' : 'ALLOW';
      const confidence = Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0;
      const source = sanitizeText(entry.source || 'ai_model', 40) || 'ai_model';
      const reason = sanitizeText(entry.reason || '', 200);
      const reportCount = parseIntOption(entry.reportCount, 0, 0);
      const appealCount = parseIntOption(entry.appealCount, 0, 0);
      const conflictGuard = source === 'quorum' ? '' : `WHERE post_decisions.source != 'appealed'`;

      stmts.push(
        this.db
          .prepare(
            `INSERT INTO post_decisions (tweet_id, handle, verdict, confidence, source, reason, report_count, appeal_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(tweet_id) DO UPDATE SET
               handle = COALESCE(NULLIF(excluded.handle, ''), post_decisions.handle),
               verdict = excluded.verdict,
               confidence = excluded.confidence,
               source = excluded.source,
               reason = excluded.reason,
               report_count = MAX(post_decisions.report_count, excluded.report_count),
               appeal_count = MAX(post_decisions.appeal_count, excluded.appeal_count),
               updated_at = excluded.updated_at
             ${conflictGuard}`
          )
          .bind(tweetId, handle, verdict, confidence, source, reason, reportCount, appealCount, now, now)
      );

      if (verdict === 'SLOP' && handle) {
        slopHandles.add(handle);
      }
    }

    if (stmts.length === 0) return { escalatedHandles: [] };
    await this.db.batch(stmts);
    this._invalidateStatsCache();

    const counterRow = await this._readCounterRow();
    const total = Number(counterRow.cached_post_count || 0);
    if (total > this.maxPostDecisions) {
      const excess = total - this.maxPostDecisions;
      await this.db
        .prepare(
          `DELETE FROM post_decisions
           WHERE tweet_id IN (
             SELECT tweet_id FROM post_decisions
             WHERE verdict = 'ALLOW' AND source != 'appealed'
             ORDER BY updated_at ASC
             LIMIT ?
           )`
        )
        .bind(excess)
        .run();
      this._invalidateStatsCache();
    }

    const escalatedHandles = [];
    for (const h of slopHandles) {
      const didEscalate = await this._checkAndEscalateAccount(h, now);
      if (didEscalate) escalatedHandles.push(h);
    }

    return { escalatedHandles };
  }

  /**
   * Append bounded ring-buffer decision logs for auditing AI verdicts & scores.
   */
  async appendDecisionLogs(entries = []) {
    await this.ensureSchema();
    if (!Array.isArray(entries) || entries.length === 0) return;

    const now = new Date().toISOString();
    const stmts = [];
    for (const entry of entries) {
      if (!entry) continue;
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO decision_logs (tweet_id, handle, is_reply, is_verified, verdict, slop_prob, confidence, text_excerpt, parent_excerpt, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            sanitizeText(String(entry.tweetId || ''), 128),
            normalizeHandle(entry.handle || ''),
            entry.isReply ? 1 : 0,
            entry.isVerified ? 1 : 0,
            String(entry.verdict || '').toUpperCase() === 'SLOP' ? 'SLOP' : 'ALLOW',
            Number.isFinite(Number(entry.slopProb)) ? Number(entry.slopProb) : 0,
            Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0,
            sanitizeText(entry.text || entry.quotedText || '', 180),
            sanitizeText(entry.parentText || '', 100),
            now
          )
      );
    }
    if (stmts.length === 0) return;
    const batchRes = await this.db.batch(stmts);

    let maxId = Number(batchRes?.[batchRes.length - 1]?.meta?.last_row_id || 0);
    if (!Number.isFinite(maxId) || maxId <= 0) {
      const maxRow = await this.db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM decision_logs').first();
      maxId = Number(maxRow?.maxId || 0);
    }
    if (maxId > this.maxDecisionLogs) {
      await this.db
        .prepare('DELETE FROM decision_logs WHERE id <= ?')
        .bind(maxId - this.maxDecisionLogs)
        .run();
    }
  }

  async getBlacklist({ since = null, sinceVersion = null } = {}) {
    await this.ensureSchema();
    const meta = await this.db
      .prepare(
        `SELECT
           COALESCE((SELECT version FROM blacklist ORDER BY version DESC LIMIT 1), 0) AS maxVer,
           (SELECT updated_at FROM blacklist ORDER BY updated_at DESC LIMIT 1) AS maxUpdatedAt`
      )
      .first();
    const currentVersion = Number(meta?.maxVer || 0);
    const updatedAt = meta?.maxUpdatedAt || new Date().toISOString();

    const parsedVer =
      sinceVersion !== null && sinceVersion !== undefined && String(sinceVersion).trim() !== ''
        ? Number(sinceVersion)
        : NaN;

    if (Number.isFinite(parsedVer) && parsedVer >= 0) {
      if (parsedVer >= currentVersion) {
        return this._formatIncrementalBlacklist([], currentVersion, updatedAt);
      }
      const res = await this.db
        .prepare(
          'SELECT handle, reason, source, report_count, active, version, updated_at FROM blacklist WHERE version > ? ORDER BY version ASC'
        )
        .bind(parsedVer)
        .all();
      return this._formatIncrementalBlacklist(res?.results || [], currentVersion, updatedAt);
    }

    if (since && typeof since === 'string') {
      const parsedMs = Date.parse(since);
      if (!Number.isNaN(parsedMs)) {
        const sinceIso = new Date(parsedMs).toISOString();
        const res = await this.db
          .prepare(
            'SELECT handle, reason, source, report_count, active, version, updated_at FROM blacklist WHERE updated_at > ? ORDER BY version ASC'
          )
          .bind(sinceIso)
          .all();
        return this._formatIncrementalBlacklist(res?.results || [], currentVersion, updatedAt);
      }
    }

    const res = await this.db
      .prepare(
        'SELECT handle, reason, source, report_count, version, updated_at FROM blacklist WHERE active = 1 ORDER BY version DESC'
      )
      .all();
    const accounts = (res?.results || []).map((row) => ({
      handle: row.handle,
      reason: row.reason,
      source: row.source,
      reportCount: Number(row.report_count || 1),
      version: Number(row.version || 1),
      updatedAt: row.updated_at,
    }));
    return { version: currentVersion, updatedAt, incremental: false, accounts, removed: [] };
  }

  _formatIncrementalBlacklist(rows, currentVersion, updatedAt) {
    const accounts = [];
    const removed = [];
    for (const row of rows) {
      if (Number(row.active) === 1) {
        accounts.push({
          handle: row.handle,
          reason: row.reason,
          source: row.source,
          reportCount: Number(row.report_count || 1),
          version: Number(row.version || 1),
          updatedAt: row.updated_at,
        });
      } else {
        removed.push(row.handle);
      }
    }
    return { version: currentVersion, updatedAt, incremental: true, accounts, removed };
  }

  async getStats() {
    await this.ensureSchema();
    const today = new Date().toISOString().slice(0, 10);
    if (
      this.statsCacheTtlMs > 0 &&
      this._statsCache &&
      this._statsCache.day === today &&
      Date.now() < this._statsCache.expiresAt
    ) {
      return { ...this._statsCache.data };
    }

    const [counters, usageRow] = await Promise.all([
      this._readCounterRow(),
      this.db.prepare('SELECT call_count, item_count FROM ai_usage_daily WHERE usage_day = ?').bind(today).first(),
    ]);

    const result = {
      blacklistCount: Number(counters.active_blacklist_count || 0),
      blacklistVersion: Number(counters.blacklist_version || 0),
      slopPostCount: Number(counters.slop_post_count || 0),
      cachedPostCount: Number(counters.cached_post_count || 0),
      sampleCount: Number(counters.sample_count || 0),
      todayAiCalls: Number(usageRow?.call_count || 0),
      todayAiItems: Number(usageRow?.item_count || 0),
      aiDailyItemLimit: this.aiDailyItemLimit,
      reportQuorum: this.reportQuorum,
      escalationThreshold: this.escalationThreshold,
    };

    if (this.statsCacheTtlMs > 0) {
      this._statsCache = {
        day: today,
        expiresAt: Date.now() + this.statsCacheTtlMs,
        data: result,
      };
    }

    return { ...result };
  }

  async recordSignal(payload = {}, { aiVerifier = null, ipHash = '', deferTask = null, onBlacklistChange = null } = {}) {
    await this.ensureSchema();
    const type = String(payload.type || '').trim().toUpperCase();
    const handle = normalizeHandle(payload.handle || '');
    const clientId = sanitizeClientId(payload.clientId);
    const tweetId = payload.tweetId ? String(payload.tweetId).trim().slice(0, 128) : '';
    const displayName = sanitizeText(payload.displayName, 120);
    const text = sanitizeText(payload.text, 800);
    const quotedHandle = normalizeHandle(payload.quotedHandle || '');
    const quotedText = sanitizeText(payload.quotedText, 400);
    const reason = sanitizeText(payload.reason, 200) || 'USER_REPORT';
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const cacheableTweet = isCacheableTweetId(tweetId, handle);

    const runTask = (fn) => {
      const p = Promise.resolve()
        .then(fn)
        .catch(() => {});
      if (typeof deferTask === 'function') {
        deferTask(p);
        return null;
      }
      return p;
    };

    if (type === 'BLOCK_TWEET') {
      if (!tweetId && !text) {
        return { ok: false, error: 'tweetId or text is required' };
      }
      await this._insertSample({
        signalType: 'FN_TWEET',
        handle,
        tweetId,
        displayName,
        text,
        quotedText,
        reason,
        clientId,
        now,
      });

      if (!cacheableTweet) {
        return { ok: true, type, handle, tweetId, postVerdict: 'PENDING', escalated: false };
      }

      await this.db
        .prepare(
          `INSERT INTO post_votes (tweet_id, client_id, vote_type, created_at, updated_at)
           VALUES (?, ?, 'REPORT', ?, ?)
           ON CONFLICT(tweet_id, client_id) DO UPDATE SET
             vote_type = 'REPORT',
             updated_at = excluded.updated_at`
        )
        .bind(tweetId, clientId, now, now)
        .run();

      const { reportCount, appealCount } = await this._getPostVoteCounts(tweetId);
      const existingPost = await this.db
        .prepare('SELECT verdict, source FROM post_decisions WHERE tweet_id = ?')
        .bind(tweetId)
        .first();
      let postVerdict = existingPost?.verdict || 'PENDING';
      let escalated = false;

      if (reportCount - 2 * appealCount >= this.postReportQuorum) {
        const { escalatedHandles } = await this.savePostDecisions([
          {
            tweetId,
            handle,
            verdict: 'SLOP',
            confidence: 1,
            source: 'quorum',
            reason,
            reportCount,
            appealCount,
          },
        ]);
        postVerdict = 'SLOP';
        escalated = escalatedHandles.length > 0;
        if (escalated && typeof onBlacklistChange === 'function') onBlacklistChange();
      } else if (
        appealCount === 0 &&
        existingPost?.verdict !== 'SLOP' &&
        existingPost?.source !== 'appealed' &&
        aiVerifier &&
        aiVerifier.isConfigured()
      ) {
        const pending = runTask(async () => {
          const quota = await this.consumeAiQuota({ ipHash, itemCount: 1 });
          if (!quota.allowed) return;
          const [aiRes] = await aiVerifier.classifyTweetsBatch([
            { tweetId, handle, displayName, text, quotedHandle, quotedText },
          ]);
          if (aiRes && aiRes.verdict === 'SLOP') {
            const { escalatedHandles } = await this.savePostDecisions([
              {
                tweetId,
                handle: aiRes.matchedHandle || handle,
                verdict: 'SLOP',
                confidence: aiRes.confidence || 0.8,
                source: 'user_verified',
                reason: aiRes.reason || reason,
                reportCount,
                appealCount,
              },
            ]);
            if (escalatedHandles.length > 0 && typeof onBlacklistChange === 'function') {
              onBlacklistChange();
            }
          }
        });
        if (pending) {
          await pending;
          const refreshed = await this.db.prepare('SELECT verdict FROM post_decisions WHERE tweet_id = ?').bind(tweetId).first();
          if (refreshed?.verdict) postVerdict = refreshed.verdict;
          if (handle) {
            const bl = await this._getBlacklistRow(handle);
            escalated = Boolean(bl && Number(bl.active) === 1);
          }
        }
      }

      return { ok: true, type, handle, tweetId, postVerdict, reportCount, appealCount, escalated };
    }

    if (type === 'APPEAL_TWEET') {
      if (!tweetId && !text) {
        return { ok: false, error: 'tweetId or text is required' };
      }
      await this._insertSample({
        signalType: 'FP_TWEET',
        handle,
        tweetId,
        displayName,
        text,
        quotedText,
        reason,
        clientId,
        now,
      });

      if (!cacheableTweet) {
        return { ok: true, type, handle, tweetId, flippedToAllow: false };
      }

      await this.db
        .prepare(
          `INSERT INTO post_votes (tweet_id, client_id, vote_type, created_at, updated_at)
           VALUES (?, ?, 'APPEAL', ?, ?)
           ON CONFLICT(tweet_id, client_id) DO UPDATE SET
             vote_type = 'APPEAL',
             updated_at = excluded.updated_at`
        )
        .bind(tweetId, clientId, now, now)
        .run();

      const { reportCount, appealCount } = await this._getPostVoteCounts(tweetId);
      let flippedToAllow = false;

      if (appealCount >= 1 && reportCount - 2 * appealCount < this.postReportQuorum) {
        await this.db
          .prepare(
            `INSERT INTO post_decisions (tweet_id, handle, verdict, confidence, source, reason, report_count, appeal_count, created_at, updated_at)
             VALUES (?, ?, 'ALLOW', 1, 'appealed', 'Appealed by user', ?, ?, ?, ?)
             ON CONFLICT(tweet_id) DO UPDATE SET
               verdict = 'ALLOW',
               confidence = 1,
               source = 'appealed',
               reason = 'Appealed by user',
               report_count = excluded.report_count,
               appeal_count = excluded.appeal_count,
               updated_at = excluded.updated_at`
          )
          .bind(tweetId, handle, reportCount, appealCount, now, now)
          .run();
        flippedToAllow = true;
        this._invalidateStatsCache();
      } else {
        await this.db
          .prepare('UPDATE post_decisions SET report_count = ?, appeal_count = ?, updated_at = ? WHERE tweet_id = ?')
          .bind(reportCount, appealCount, now, tweetId)
          .run();
        this._invalidateStatsCache();
      }

      return { ok: true, type, handle, tweetId, flippedToAllow, reportCount, appealCount };
    }

    if (!handle) {
      return { ok: false, error: 'valid handle is required' };
    }

    if (type === 'BLOCK_ACCOUNT') {
      await this.db
        .prepare(
          `INSERT INTO signal_votes (handle, client_id, vote_type, sample_text, created_at, updated_at)
           VALUES (?, ?, 'REPORT', ?, ?, ?)
           ON CONFLICT(handle, client_id) DO UPDATE SET
             vote_type = 'REPORT',
             sample_text = excluded.sample_text,
             updated_at = excluded.updated_at`
        )
        .bind(handle, clientId, text || quotedText, now, now)
        .run();

      await this._insertSample({
        signalType: 'FN_ACCOUNT',
        handle,
        tweetId,
        displayName,
        text,
        quotedText,
        reason,
        clientId,
        now,
      });

      const { reportCount, appealCount } = await this._getVoteCounts(handle);
      const netVotes = reportCount - 2 * appealCount;
      const existing = await this._getBlacklistRow(handle);
      let blacklisted = Boolean(existing && Number(existing.active) === 1);
      let aiVerified = false;
      let postSlop = false;

      if (blacklisted) {
        await this.db
          .prepare('UPDATE blacklist SET report_count = ?, fp_count = ?, updated_at = ? WHERE handle = ?')
          .bind(reportCount, appealCount, now, handle)
          .run();
      } else if (netVotes >= this.reportQuorum) {
        await this._activateBlacklist(handle, {
          reason,
          source: 'quorum',
          reportCount,
          fpCount: appealCount,
          now,
        });
        blacklisted = true;
        if (typeof onBlacklistChange === 'function') onBlacklistChange();
      } else if (appealCount === 0 && aiVerifier && aiVerifier.isConfigured()) {
        const [prevVerify, sampleCountRow, samplesRes] = await Promise.all([
          this.db
            .prepare('SELECT handle, verdict, confidence, verify_count, sample_count FROM ai_verifications WHERE handle = ?')
            .bind(handle)
            .first(),
          this.db.prepare('SELECT COUNT(*) AS cnt FROM flywheel_samples WHERE handle = ?').bind(handle).first(),
          this.db
            .prepare(
              'SELECT signal_type, display_name, text, quoted_text, reason, created_at FROM flywheel_samples WHERE handle = ? ORDER BY id DESC LIMIT 5'
            )
            .bind(handle)
            .all(),
        ]);

        const currentSampleCount = Number(sampleCountRow?.cnt || 0);
        const samples = samplesRes?.results || [];
        const neverVerified = !prevVerify;
        const canReverify =
          Boolean(prevVerify) &&
          prevVerify.verdict === 'UNCERTAIN' &&
          currentSampleCount > Number(prevVerify.sample_count || 0) &&
          Number(prevVerify.verify_count || 1) < 3;

        if (neverVerified || canReverify) {
          const pending = runTask(async () => {
            const quota = await this.consumeAiQuota({ ipHash, itemCount: 1 });
            if (!quota.allowed) return;

            const aiRes = await aiVerifier.verifyAccountCandidate({
              handle,
              displayName,
              text,
              quotedHandle,
              quotedText,
              samples,
            });
            if (!aiRes.ok) return;

            const nextVerifyCount = prevVerify ? Number(prevVerify.verify_count || 1) + 1 : 1;
            await this.db
              .prepare(
                `INSERT INTO ai_verifications (handle, verdict, confidence, reason, verify_count, sample_count, verified_day, verified_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(handle) DO UPDATE SET
                   verdict = excluded.verdict,
                   confidence = excluded.confidence,
                   reason = excluded.reason,
                   verify_count = excluded.verify_count,
                   sample_count = excluded.sample_count,
                   verified_day = excluded.verified_day,
                   verified_at = excluded.verified_at`
              )
              .bind(
                handle,
                aiRes.verdict || 'UNCERTAIN',
                Number(aiRes.confidence || 0),
                sanitizeText(aiRes.reason, 200),
                nextVerifyCount,
                currentSampleCount,
                today,
                now
              )
              .run();

            if (aiRes.verdict === 'SLOP' && Number(aiRes.confidence || 0) >= 0.72) {
              await this._activateBlacklist(handle, {
                reason: sanitizeText(aiRes.reason, 200) || reason,
                source: 'ai_verified',
                reportCount,
                fpCount: appealCount,
                now,
              });
              aiVerified = true;
              if (typeof onBlacklistChange === 'function') onBlacklistChange();
            } else if (aiRes.postSlop === true && cacheableTweet) {
              const { escalatedHandles } = await this.savePostDecisions([
                {
                  tweetId,
                  handle,
                  verdict: 'SLOP',
                  confidence: Number(aiRes.postConfidence || 0.8),
                  source: 'user_verified',
                  reason: sanitizeText(aiRes.reason, 200) || reason,
                },
              ]);
              postSlop = true;
              if (escalatedHandles.length > 0 && typeof onBlacklistChange === 'function') {
                onBlacklistChange();
              }
            }
          });
          if (pending) {
            await pending;
            const refreshedBl = await this._getBlacklistRow(handle);
            blacklisted = Boolean(refreshedBl && Number(refreshedBl.active) === 1);
          }
        }
      }

      return {
        ok: true,
        type,
        handle,
        blacklisted,
        pendingQuorum: !blacklisted,
        aiVerified,
        postSlop,
        reportCount,
        appealCount,
        quorum: this.reportQuorum,
      };
    }

    if (type === 'UNBLOCK_ACCOUNT') {
      await this.db
        .prepare(`DELETE FROM signal_votes WHERE handle = ? AND client_id = ? AND vote_type = 'REPORT'`)
        .bind(handle, clientId)
        .run();
      await this.db
        .prepare(`DELETE FROM flywheel_samples WHERE client_id = ? AND signal_type = 'FN_ACCOUNT' AND handle = ?`)
        .bind(clientId, handle)
        .run();
      this._invalidateStatsCache();

      const { reportCount, appealCount } = await this._getVoteCounts(handle);
      const existing = await this._getBlacklistRow(handle);
      let removedFromBlacklist = false;

      if (existing && Number(existing.active) === 1) {
        const shouldRemove =
          reportCount === 0 || (existing.source === 'quorum' && reportCount - 2 * appealCount < this.reportQuorum);
        if (shouldRemove) {
          await this._deactivateBlacklist(handle, { reportCount, fpCount: appealCount, now });
          removedFromBlacklist = true;
          if (typeof onBlacklistChange === 'function') onBlacklistChange();
        } else {
          await this.db
            .prepare('UPDATE blacklist SET report_count = ?, fp_count = ?, updated_at = ? WHERE handle = ?')
            .bind(reportCount, appealCount, now, handle)
            .run();
        }
      }

      return { ok: true, type, handle, removedFromBlacklist, reportCount, appealCount };
    }

    if (type === 'APPEAL_ACCOUNT') {
      await this.db
        .prepare(
          `INSERT INTO signal_votes (handle, client_id, vote_type, sample_text, created_at, updated_at)
           VALUES (?, ?, 'APPEAL', ?, ?, ?)
           ON CONFLICT(handle, client_id) DO UPDATE SET
             vote_type = 'APPEAL',
             sample_text = excluded.sample_text,
             updated_at = excluded.updated_at`
        )
        .bind(handle, clientId, text || quotedText, now, now)
        .run();

      await this._insertSample({
        signalType: 'FP_ACCOUNT',
        handle,
        tweetId,
        displayName,
        text,
        quotedText,
        reason,
        clientId,
        now,
      });

      const { reportCount, appealCount } = await this._getVoteCounts(handle);
      const existing = await this._getBlacklistRow(handle);
      let removedFromBlacklist = false;

      if (existing && Number(existing.active) === 1) {
        const isAiOrEscalated = existing.source === 'ai_verified' || existing.source === 'post_escalation';
        const shouldRemove =
          (isAiOrEscalated && appealCount >= 1) || reportCount - 2 * appealCount < this.reportQuorum;

        if (shouldRemove) {
          await this._deactivateBlacklist(handle, { reportCount, fpCount: appealCount, now });
          removedFromBlacklist = true;
          if (typeof onBlacklistChange === 'function') onBlacklistChange();
        } else {
          await this.db
            .prepare('UPDATE blacklist SET report_count = ?, fp_count = ?, updated_at = ? WHERE handle = ?')
            .bind(reportCount, appealCount, now, handle)
            .run();
        }
      }

      return { ok: true, type, handle, removedFromBlacklist, reportCount, appealCount };
    }

    return { ok: false, error: `Unsupported signal type: ${type}` };
  }
}

CREATE TABLE IF NOT EXISTS post_decisions (
  tweet_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  slop_prob REAL,
  source TEXT NOT NULL DEFAULT 'ai_model',
  reason TEXT NOT NULL DEFAULT '',
  report_count INTEGER NOT NULL DEFAULT 0,
  appeal_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_post_decisions_handle ON post_decisions(handle, verdict);
CREATE INDEX IF NOT EXISTS idx_post_decisions_updated ON post_decisions(updated_at);
CREATE INDEX IF NOT EXISTS idx_post_decisions_prune
  ON post_decisions(updated_at)
  WHERE verdict = 'ALLOW' AND source != 'appealed';

CREATE TABLE IF NOT EXISTS post_votes (
  tweet_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  vote_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tweet_id, client_id)
);

CREATE TABLE IF NOT EXISTS blacklist (
  handle TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'USER_REPORT',
  source TEXT NOT NULL DEFAULT 'quorum',
  report_count INTEGER NOT NULL DEFAULT 1,
  fp_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blacklist_updated ON blacklist(updated_at);
CREATE INDEX IF NOT EXISTS idx_blacklist_version ON blacklist(version);

CREATE TABLE IF NOT EXISTS signal_votes (
  handle TEXT NOT NULL,
  client_id TEXT NOT NULL,
  vote_type TEXT NOT NULL,
  sample_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (handle, client_id)
);

CREATE TABLE IF NOT EXISTS flywheel_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_type TEXT NOT NULL,
  handle TEXT NOT NULL DEFAULT '',
  tweet_id TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  quoted_text TEXT NOT NULL DEFAULT '',
  quoted_handle TEXT NOT NULL DEFAULT '',
  parent_handle TEXT NOT NULL DEFAULT '',
  parent_text TEXT NOT NULL DEFAULT '',
  is_reply INTEGER NOT NULL DEFAULT 0,
  is_verified INTEGER NOT NULL DEFAULT 0,
  orig_verdict TEXT NOT NULL DEFAULT '',
  orig_slop_prob REAL,
  orig_source TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (client_id, signal_type, handle, tweet_id)
);

CREATE INDEX IF NOT EXISTS idx_samples_handle ON flywheel_samples(handle, id DESC);

CREATE TABLE IF NOT EXISTS ai_verifications (
  handle TEXT PRIMARY KEY,
  verdict TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  verify_count INTEGER NOT NULL DEFAULT 1,
  sample_count INTEGER NOT NULL DEFAULT 0,
  verified_day TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_verifications_day ON ai_verifications(verified_day);

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  usage_day TEXT PRIMARY KEY,
  call_count INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ip_daily_usage (
  usage_day TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (usage_day, ip_hash)
);

CREATE TABLE IF NOT EXISTS decision_logs (
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
);

CREATE INDEX IF NOT EXISTS idx_decision_logs_created ON decision_logs(id DESC);

CREATE TABLE IF NOT EXISTS flywheel_counters (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_blacklist_count INTEGER NOT NULL DEFAULT 0,
  blacklist_version INTEGER NOT NULL DEFAULT 0,
  cached_post_count INTEGER NOT NULL DEFAULT 0,
  slop_post_count INTEGER NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER IF NOT EXISTS trg_post_decisions_ai AFTER INSERT ON post_decisions
BEGIN
  UPDATE flywheel_counters
  SET cached_post_count = cached_post_count + 1,
      slop_post_count = slop_post_count + CASE WHEN NEW.verdict = 'SLOP' THEN 1 ELSE 0 END
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_post_decisions_au AFTER UPDATE OF verdict ON post_decisions
WHEN OLD.verdict != NEW.verdict
BEGIN
  UPDATE flywheel_counters
  SET slop_post_count = MAX(0, slop_post_count + CASE WHEN NEW.verdict = 'SLOP' THEN 1 ELSE -1 END)
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_post_decisions_ad AFTER DELETE ON post_decisions
BEGIN
  UPDATE flywheel_counters
  SET cached_post_count = MAX(0, cached_post_count - 1),
      slop_post_count = MAX(0, slop_post_count - CASE WHEN OLD.verdict = 'SLOP' THEN 1 ELSE 0 END)
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_blacklist_ai AFTER INSERT ON blacklist
BEGIN
  UPDATE flywheel_counters
  SET active_blacklist_count = active_blacklist_count + CASE WHEN NEW.active = 1 THEN 1 ELSE 0 END,
      blacklist_version = MAX(blacklist_version, NEW.version)
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_blacklist_au AFTER UPDATE OF active, version ON blacklist
WHEN OLD.active != NEW.active OR OLD.version != NEW.version
BEGIN
  UPDATE flywheel_counters
  SET active_blacklist_count = MAX(0, active_blacklist_count + (CASE WHEN NEW.active = 1 THEN 1 ELSE 0 END) - (CASE WHEN OLD.active = 1 THEN 1 ELSE 0 END)),
      blacklist_version = MAX(blacklist_version, NEW.version)
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_blacklist_ad AFTER DELETE ON blacklist
BEGIN
  UPDATE flywheel_counters
  SET active_blacklist_count = MAX(0, active_blacklist_count - CASE WHEN OLD.active = 1 THEN 1 ELSE 0 END)
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_flywheel_samples_ai AFTER INSERT ON flywheel_samples
BEGIN
  UPDATE flywheel_counters
  SET sample_count = sample_count + 1
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_flywheel_samples_ad AFTER DELETE ON flywheel_samples
BEGIN
  UPDATE flywheel_counters
  SET sample_count = MAX(0, sample_count - 1)
  WHERE id = 1;
END;

INSERT INTO flywheel_counters (
  id, active_blacklist_count, blacklist_version, cached_post_count, slop_post_count, sample_count
)
VALUES (
  1,
  (SELECT COUNT(*) FROM blacklist WHERE active = 1),
  (SELECT COALESCE(MAX(version), 0) FROM blacklist),
  (SELECT COUNT(*) FROM post_decisions),
  (SELECT COUNT(*) FROM post_decisions WHERE verdict = 'SLOP'),
  (SELECT COUNT(*) FROM flywheel_samples)
)
ON CONFLICT(id) DO UPDATE SET
  active_blacklist_count = excluded.active_blacklist_count,
  blacklist_version = excluded.blacklist_version,
  cached_post_count = excluded.cached_post_count,
  slop_post_count = excluded.slop_post_count,
  sample_count = excluded.sample_count;

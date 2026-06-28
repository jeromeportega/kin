-- kin DB schema (extracted from the Python db.py; apply to a fresh Turso DB:
--   turso db shell <db> < db/schema.sql

CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE emails (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'jerome',
  folder TEXT NOT NULL DEFAULT 'INBOX',
  message_id TEXT NOT NULL CHECK (message_id != ''),
  uid TEXT,
  from_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  date TEXT NOT NULL,
  text_body TEXT NOT NULL,
  truncated INTEGER NOT NULL CHECK (truncated IN (0,1)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (user_id, message_id)
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'jerome',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  hours INTEGER,
  limit_n INTEGER,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  args TEXT NOT NULL,
  fetched INTEGER DEFAULT 0,
  filtered INTEGER DEFAULT 0,
  classified INTEGER DEFAULT 0,
  reused INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  truncated INTEGER DEFAULT 0
);

CREATE TABLE classifications (
  id INTEGER PRIMARY KEY,
  email_id INTEGER NOT NULL REFERENCES emails (id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES runs (id),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  category TEXT,
  priority TEXT,
  action_required INTEGER CHECK (action_required IN (0,1)),
  summary TEXT,
  action_items TEXT,
  dates TEXT,
  confidence REAL,
  truncated INTEGER NOT NULL CHECK (truncated IN (0,1)),
  error TEXT,
  classified_at TEXT NOT NULL,
  CHECK ((error IS NULL) != (category IS NULL))
);

CREATE TABLE digests (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'jerome',
  generated_at TEXT NOT NULL,
  window_hours INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  include_other INTEGER NOT NULL CHECK (include_other IN (0,1)),
  args TEXT NOT NULL,
  classified_count INTEGER NOT NULL,
  actionable_count INTEGER NOT NULL,
  informational_count INTEGER NOT NULL,
  skipped_other_count INTEGER NOT NULL,
  dropped_low_count INTEGER NOT NULL,
  markdown TEXT NOT NULL,
  json_payload TEXT NOT NULL
);

CREATE TABLE digest_items (
  id INTEGER PRIMARY KEY,
  digest_id INTEGER NOT NULL REFERENCES digests (id) ON DELETE CASCADE,
  classification_id INTEGER NOT NULL REFERENCES classifications (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  UNIQUE (digest_id, position),
  UNIQUE (digest_id, classification_id)
);

CREATE TABLE filter_entries (
  user_id TEXT NOT NULL DEFAULT 'jerome',
  kind TEXT NOT NULL CHECK (kind IN (
    'sender_allowlist', 'sender_blocklist', 'subject_keywords', 'body_keywords'
  )),
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, value)
);

CREATE TABLE gmail_tokens (
  email TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  scope TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_emails_user_date ON emails (user_id, date DESC);

CREATE INDEX idx_runs_user_started ON runs (user_id, started_at DESC);

CREATE UNIQUE INDEX idx_class_unique_success
  ON classifications (email_id, model, prompt_version)
  WHERE error IS NULL;

CREATE INDEX idx_class_email ON classifications (email_id);

CREATE INDEX idx_class_classified_at ON classifications (classified_at DESC);

CREATE INDEX idx_digests_user_generated
  ON digests (user_id, generated_at DESC);

CREATE INDEX idx_digest_items_class
  ON digest_items (classification_id);

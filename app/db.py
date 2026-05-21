"""SQLite persistence for kin.

Three tables:
- `emails`: one row per (user_id, message_id). Holds enough to re-classify
  offline without hitting IMAP again (full text_body + truncated flag).
- `runs`: one row per triage invocation. Argument/result counters.
- `classifications`: one row per (email_id, model, prompt_version) for
  successes (enforced by a partial unique index where error IS NULL), plus
  unlimited rows allowed for error retries.

All write functions take a `sqlite3.Connection` and expect the caller to
manage transactions — typically `with conn:` per message.
"""
import json
import sqlite3
from datetime import datetime
from pathlib import Path

from app.email_source import FetchedEmail
from app.schemas.email import EmailClassification

SCHEMA_VERSION = "1"


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
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
CREATE INDEX IF NOT EXISTS idx_emails_user_date ON emails (user_id, date DESC);

CREATE TABLE IF NOT EXISTS runs (
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
CREATE INDEX IF NOT EXISTS idx_runs_user_started ON runs (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS classifications (
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_class_unique_success
  ON classifications (email_id, model, prompt_version)
  WHERE error IS NULL;
CREATE INDEX IF NOT EXISTS idx_class_email ON classifications (email_id);
CREATE INDEX IF NOT EXISTS idx_class_classified_at ON classifications (classified_at DESC);
"""


def connect(path: Path | str) -> sqlite3.Connection:
    """Open the DB, set pragmas (WAL + foreign keys), and run init_schema."""
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    init_schema(conn)
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    """Idempotent schema bootstrap. Raises if schema_version doesn't match."""
    conn.executescript(_SCHEMA_SQL)
    existing = conn.execute(
        "SELECT value FROM _meta WHERE key = 'schema_version'"
    ).fetchone()
    if existing is None:
        conn.execute(
            "INSERT INTO _meta (key, value) VALUES ('schema_version', ?)",
            (SCHEMA_VERSION,),
        )
        conn.commit()
    elif existing["value"] != SCHEMA_VERSION:
        raise RuntimeError(
            f"DB schema_version is {existing['value']!r}, expected {SCHEMA_VERSION!r}. "
            "Migrations are not yet implemented."
        )


def _iso(now: datetime) -> str:
    if now.tzinfo is None:
        raise ValueError("naive datetimes are not allowed; pass a tz-aware datetime")
    return now.isoformat()


def upsert_email(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    folder: str,
    msg: FetchedEmail,
    now: datetime,
) -> int:
    """INSERT a new email or bump last_seen_at on an existing one. Returns id.

    The (user_id, message_id) pair is unique. Idempotent: calling twice with
    the same message returns the same id, and updates `last_seen_at`.
    """
    if msg.date.tzinfo is None:
        raise ValueError(f"FetchedEmail.date must be tz-aware: {msg!r}")
    iso_now = _iso(now)
    cur = conn.execute(
        """
        INSERT INTO emails (
            user_id, folder, message_id, uid, from_addr, subject,
            date, text_body, truncated, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, message_id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at
        RETURNING id
        """,
        (
            user_id,
            folder,
            msg.message_id,
            msg.uid,
            msg.from_addr,
            msg.subject,
            msg.date.isoformat(),
            msg.text_body,
            1 if msg.truncated else 0,
            iso_now,
            iso_now,
        ),
    )
    return cur.fetchone()[0]


def find_classification(
    conn: sqlite3.Connection,
    *,
    email_id: int,
    model: str,
    prompt_version: str,
) -> dict | None:
    """Return the most recent SUCCESSFUL classification for (email, model, prompt).

    Error rows are ignored so transient failures auto-retry on the next run.
    Returns a plain dict (action_items / dates decoded from JSON), or None.
    """
    row = conn.execute(
        """
        SELECT category, priority, action_required, summary,
               action_items, dates, confidence
        FROM classifications
        WHERE email_id = ? AND model = ? AND prompt_version = ?
          AND error IS NULL
        ORDER BY classified_at DESC
        LIMIT 1
        """,
        (email_id, model, prompt_version),
    ).fetchone()
    if row is None:
        return None
    return {
        "category": row["category"],
        "priority": row["priority"],
        "action_required": bool(row["action_required"]),
        "summary": row["summary"],
        "action_items": json.loads(row["action_items"]),
        "dates": json.loads(row["dates"]),
        "confidence": row["confidence"],
    }


def insert_classification(
    conn: sqlite3.Connection,
    *,
    email_id: int,
    run_id: int | None,
    model: str,
    prompt_version: str,
    result: EmailClassification,
    truncated: bool,
    now: datetime,
) -> int:
    """Insert a successful classification row. Raises IntegrityError if a
    successful row already exists for (email_id, model, prompt_version)."""
    cur = conn.execute(
        """
        INSERT INTO classifications (
            email_id, run_id, model, prompt_version,
            category, priority, action_required, summary,
            action_items, dates, confidence, truncated,
            error, classified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        """,
        (
            email_id,
            run_id,
            model,
            prompt_version,
            result.category.value,
            result.priority.value,
            1 if result.action_required else 0,
            result.summary,
            json.dumps(result.action_items),
            json.dumps(result.dates),
            result.confidence,
            1 if truncated else 0,
            _iso(now),
        ),
    )
    return cur.lastrowid


def insert_classification_error(
    conn: sqlite3.Connection,
    *,
    email_id: int,
    run_id: int | None,
    model: str,
    prompt_version: str,
    error: str,
    truncated: bool,
    now: datetime,
) -> int:
    """Insert an error row. Always allowed — the success-only partial unique
    index does not constrain rows where error IS NOT NULL."""
    cur = conn.execute(
        """
        INSERT INTO classifications (
            email_id, run_id, model, prompt_version,
            category, priority, action_required, summary,
            action_items, dates, confidence, truncated,
            error, classified_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
        """,
        (
            email_id,
            run_id,
            model,
            prompt_version,
            1 if truncated else 0,
            error,
            _iso(now),
        ),
    )
    return cur.lastrowid


def start_run(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    args: dict,
    model: str,
    prompt_version: str,
    hours: int,
    limit_n: int,
    now: datetime,
) -> int:
    cur = conn.execute(
        """
        INSERT INTO runs (
            user_id, started_at, hours, limit_n, model, prompt_version, args
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            user_id,
            _iso(now),
            hours,
            limit_n,
            model,
            prompt_version,
            json.dumps(args, default=str),
        ),
    )
    return cur.lastrowid


def finish_run(
    conn: sqlite3.Connection,
    *,
    run_id: int,
    fetched: int,
    filtered: int,
    classified: int,
    reused: int,
    errors: int,
    truncated: int,
    now: datetime,
) -> None:
    conn.execute(
        """
        UPDATE runs SET
            ended_at = ?, fetched = ?, filtered = ?, classified = ?,
            reused = ?, errors = ?, truncated = ?
        WHERE id = ?
        """,
        (_iso(now), fetched, filtered, classified, reused, errors, truncated, run_id),
    )

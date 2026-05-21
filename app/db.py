"""SQLite persistence for kin.

Tables:
- `emails`: one row per (user_id, message_id). Holds enough to re-classify
  offline (full text_body + truncated flag).
- `runs`: one row per triage invocation.
- `classifications`: one row per (email_id, model, prompt_version) for
  successes (enforced by a partial unique index where error IS NULL), plus
  unlimited rows allowed for error retries.
- `digests`: one row per digest invocation (Phase 4+).
- `digest_items`: links a digest to the classifications it surfaced.

All write functions take a `sqlite3.Connection` and expect the caller to
manage transactions — typically `with conn:` per logical unit.
"""
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

from app.email_source import FetchedEmail
from app.schemas.email import EmailClassification

SCHEMA_VERSION = "2"


@dataclass(frozen=True)
class MigrationStep:
    """One step in the version-to-version migration graph.

    `pre_sql` runs first (additive DDL, or destructive DDL on doomed columns).
    `data_fn` runs next (transforms rows). `post_sql` runs last (clean-up DDL,
    e.g. dropping old columns). Each phase is optional — None means skip.
    """
    pre_sql: str | None = None
    data_fn: Callable[[sqlite3.Connection], None] | None = None
    post_sql: str | None = None


_V2_NEW_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS digests (
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
CREATE INDEX IF NOT EXISTS idx_digests_user_generated
  ON digests (user_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS digest_items (
  id INTEGER PRIMARY KEY,
  digest_id INTEGER NOT NULL REFERENCES digests (id) ON DELETE CASCADE,
  classification_id INTEGER NOT NULL REFERENCES classifications (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  UNIQUE (digest_id, position),
  UNIQUE (digest_id, classification_id)
);
CREATE INDEX IF NOT EXISTS idx_digest_items_class
  ON digest_items (classification_id);
"""


# Migration paths keyed by (from_version, to_version). Add entries as you
# bump SCHEMA_VERSION. v1→v2 is purely additive; the new-tables SQL is
# safe to re-run.
_MIGRATIONS: dict[tuple[str, str], MigrationStep] = {
    ("1", "2"): MigrationStep(pre_sql=_V2_NEW_TABLES_SQL),
}


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
""" + _V2_NEW_TABLES_SQL


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
    """Idempotent schema bootstrap with migration support.

    Order of operations:
    1. Ensure `_meta` exists (need it to read the version).
    2. Inspect `_meta.schema_version`:
       - missing → fresh DB; run full current schema, seed version.
       - matches SCHEMA_VERSION → idempotent backstop only.
       - older → look up migration in `_MIGRATIONS` and run it; bail if no path.
       - newer → raise (can't downgrade).
    3. Always finish with an idempotent backstop `executescript(_SCHEMA_SQL)`
       so any tables a migration somehow skipped get created.

    Reading version *before* the backstop is the key change from Phase 3:
    future destructive migrations can inspect v1 state before the new schema
    is applied.
    """
    conn.execute(
        "CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    row = conn.execute(
        "SELECT value FROM _meta WHERE key = 'schema_version'"
    ).fetchone()

    if row is None:
        # Fresh DB.
        conn.executescript(_SCHEMA_SQL)
        conn.execute(
            "INSERT INTO _meta (key, value) VALUES ('schema_version', ?)",
            (SCHEMA_VERSION,),
        )
    elif row["value"] != SCHEMA_VERSION:
        from_v = row["value"]
        to_v = SCHEMA_VERSION
        step = _MIGRATIONS.get((from_v, to_v))
        if step is None:
            raise RuntimeError(
                f"DB schema_version is {from_v!r}; no migration path to "
                f"{to_v!r}. Migrations available: {sorted(_MIGRATIONS.keys())}"
            )
        if step.pre_sql:
            conn.executescript(step.pre_sql)
        if step.data_fn:
            step.data_fn(conn)
        if step.post_sql:
            conn.executescript(step.post_sql)
        conn.execute(
            "UPDATE _meta SET value = ? WHERE key = 'schema_version'",
            (to_v,),
        )
        # Idempotent backstop in case the migration skipped a table.
        conn.executescript(_SCHEMA_SQL)
    else:
        # Already current — idempotent backstop only.
        conn.executescript(_SCHEMA_SQL)

    conn.commit()


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
    """INSERT a new email or bump last_seen_at on an existing one. Returns id."""
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
    """Return the most recent SUCCESSFUL classification for (email, model, prompt)."""
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
    """Insert a successful classification row."""
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
    """Insert an error row. Allowed without UNIQUE collision (partial index)."""
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


def fetch_classifications_window(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    window_start: datetime,
    window_end: datetime,
    model: str | None = None,
    prompt_version: str | None = None,
) -> list[dict]:
    """Return joined (email + classification) rows within the window.

    By default, returns the *latest successful classification per email* —
    so prompt iterations don't silently drop emails classified under a
    prior version. When both `model` and `prompt_version` are supplied,
    filters to that exact pair (forensic mode).
    """
    if window_start.tzinfo is None or window_end.tzinfo is None:
        raise ValueError("window dates must be tz-aware")
    if (model is None) != (prompt_version is None):
        raise ValueError(
            "specify both model and prompt_version, or neither"
        )

    base_select = """
        SELECT
            c.id  AS classification_id,
            c.model,
            c.prompt_version,
            c.category,
            c.priority,
            c.action_required,
            c.summary,
            c.action_items,
            c.dates,
            c.confidence,
            c.classified_at,
            e.id          AS email_id,
            e.message_id,
            e.uid,
            e.folder,
            e.from_addr,
            e.subject,
            e.date        AS email_date
        FROM classifications c
        JOIN emails e ON e.id = c.email_id
        WHERE c.error IS NULL
          AND e.user_id = ?
          AND e.date >= ?
          AND e.date <= ?
    """
    params: tuple = (
        user_id,
        window_start.isoformat(),
        window_end.isoformat(),
    )

    if model is not None and prompt_version is not None:
        sql = base_select + """
              AND c.model = ?
              AND c.prompt_version = ?
            ORDER BY e.date DESC
        """
        params = params + (model, prompt_version)
    else:
        # Latest successful classification per email.
        sql = base_select + """
              AND c.id = (
                  SELECT c2.id
                  FROM classifications c2
                  WHERE c2.email_id = e.id AND c2.error IS NULL
                  ORDER BY c2.classified_at DESC, c2.id DESC
                  LIMIT 1
              )
            ORDER BY e.date DESC
        """

    return [
        {
            "classification_id": r["classification_id"],
            "model": r["model"],
            "prompt_version": r["prompt_version"],
            "category": r["category"],
            "priority": r["priority"],
            "action_required": bool(r["action_required"]),
            "summary": r["summary"],
            "action_items": json.loads(r["action_items"]),
            "dates": json.loads(r["dates"]),
            "confidence": r["confidence"],
            "classified_at": r["classified_at"],
            "email_id": r["email_id"],
            "message_id": r["message_id"],
            "uid": r["uid"],
            "folder": r["folder"],
            "from_addr": r["from_addr"],
            "subject": r["subject"],
            "email_date": r["email_date"],
        }
        for r in conn.execute(sql, params)
    ]


def insert_digest(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    generated_at: datetime,
    window_hours: int,
    window_start: datetime,
    window_end: datetime,
    model: str,
    prompt_version: str,
    include_other: bool,
    args: dict,
    classified_count: int,
    actionable_count: int,
    informational_count: int,
    skipped_other_count: int,
    dropped_low_count: int,
    classification_ids: list[int],
    markdown: str,
    json_payload: str,
) -> int:
    """Persist a digest + its items atomically.

    `classification_ids` is the rendered order — i.e. `digest_items.position`
    is assigned by enumeration. Performs a counter sanity check before
    committing: `COUNT(digest_items) == actionable + informational` must
    hold.
    """
    expected_items = actionable_count + informational_count
    if len(classification_ids) != expected_items:
        raise sqlite3.IntegrityError(
            f"digest counter mismatch: {len(classification_ids)} item ids vs "
            f"{expected_items} (actionable={actionable_count} + "
            f"informational={informational_count})"
        )
    with conn:
        cur = conn.execute(
            """
            INSERT INTO digests (
                user_id, generated_at, window_hours, window_start, window_end,
                model, prompt_version, include_other, args,
                classified_count, actionable_count, informational_count,
                skipped_other_count, dropped_low_count, markdown, json_payload
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                _iso(generated_at),
                window_hours,
                _iso(window_start),
                _iso(window_end),
                model,
                prompt_version,
                1 if include_other else 0,
                json.dumps(args, default=str),
                classified_count,
                actionable_count,
                informational_count,
                skipped_other_count,
                dropped_low_count,
                markdown,
                json_payload,
            ),
        )
        digest_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO digest_items (digest_id, classification_id, position) VALUES (?, ?, ?)",
            [(digest_id, cid, idx) for idx, cid in enumerate(classification_ids)],
        )
    return digest_id

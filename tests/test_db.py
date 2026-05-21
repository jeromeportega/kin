import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.db import (
    SCHEMA_VERSION,
    find_classification,
    finish_run,
    init_schema,
    insert_classification,
    insert_classification_error,
    start_run,
    upsert_email,
)
from app.email_source import FetchedEmail
from app.schemas.email import Category, EmailClassification, Priority

FIXTURES = Path(__file__).parent / "fixtures"


NOW = datetime(2026, 5, 20, 14, 0, 0, tzinfo=timezone.utc)
LATER = datetime(2026, 5, 20, 14, 5, 0, tzinfo=timezone.utc)


def _email(**overrides) -> FetchedEmail:
    base = dict(
        uid="42",
        message_id="<abc@example>",
        from_addr="someone@example.com",
        to_addrs=("you@example.com",),
        cc_addrs=(),
        subject="Hello",
        date=NOW,
        text_body="hi there",
        truncated=False,
    )
    base.update(overrides)
    return FetchedEmail(**base)


def _classification(**overrides) -> EmailClassification:
    base = dict(
        category=Category.daycare,
        priority=Priority.low,
        action_required=True,
        summary="A daycare email",
        action_items=["foo"],
        dates=["2026-05-20"],
        confidence=0.9,
    )
    base.update(overrides)
    return EmailClassification(**base)


# --- init_schema -------------------------------------------------------------

def test_init_schema_is_idempotent(mem_db):
    init_schema(mem_db)
    init_schema(mem_db)  # second call must not raise


def test_init_schema_seeds_meta_version(mem_db):
    row = mem_db.execute(
        "SELECT value FROM _meta WHERE key = 'schema_version'"
    ).fetchone()
    assert row["value"] == SCHEMA_VERSION


def test_init_schema_raises_on_version_mismatch(mem_db):
    mem_db.execute("UPDATE _meta SET value = '99' WHERE key = 'schema_version'")
    mem_db.commit()
    with pytest.raises(RuntimeError, match="no migration path"):
        init_schema(mem_db)


# --- migrations --------------------------------------------------------------

def _load_v1_db() -> sqlite3.Connection:
    """A fresh in-memory DB loaded with the snapshotted v1 schema."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    v1_sql = (FIXTURES / "schema_v1.sql").read_text()
    conn.executescript(v1_sql)
    conn.execute("INSERT INTO _meta (key, value) VALUES ('schema_version', '1')")
    conn.commit()
    return conn


def test_v1_to_v2_migration_adds_digest_tables():
    conn = _load_v1_db()
    # Sanity: v1 tables exist, v2 don't yet
    tables = {
        r["name"]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {"emails", "runs", "classifications"} <= tables
    assert "digests" not in tables
    assert "digest_items" not in tables

    init_schema(conn)

    # Version bumped
    row = conn.execute(
        "SELECT value FROM _meta WHERE key = 'schema_version'"
    ).fetchone()
    assert row["value"] == SCHEMA_VERSION  # "2"

    # New tables present
    tables = {
        r["name"]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert "digests" in tables
    assert "digest_items" in tables

    # Old tables still present
    assert {"emails", "runs", "classifications"} <= tables

    conn.close()


def test_v1_to_v2_migration_preserves_existing_data():
    conn = _load_v1_db()
    # Seed a v1 email + classification
    conn.execute(
        """INSERT INTO emails (user_id, folder, message_id, uid, from_addr, subject,
                date, text_body, truncated, first_seen_at, last_seen_at)
           VALUES ('jerome', 'INBOX', '<abc@x>', '1', 'a@b.com', 'sub',
                '2026-05-20T12:00:00+00:00', 'body', 0,
                '2026-05-20T12:00:00+00:00', '2026-05-20T12:00:00+00:00')"""
    )
    conn.commit()
    eid = conn.execute("SELECT id FROM emails").fetchone()["id"]

    init_schema(conn)

    # Email still there with same id
    row = conn.execute("SELECT subject FROM emails WHERE id = ?", (eid,)).fetchone()
    assert row["subject"] == "sub"
    conn.close()


def test_init_schema_idempotent_on_v2(mem_db):
    # mem_db is already at v2 (fixture inits at current SCHEMA_VERSION)
    init_schema(mem_db)
    init_schema(mem_db)
    row = mem_db.execute(
        "SELECT value FROM _meta WHERE key = 'schema_version'"
    ).fetchone()
    assert row["value"] == "2"


# --- upsert_email ------------------------------------------------------------

def test_upsert_email_returns_same_id_idempotent(mem_db):
    msg = _email()
    id1 = upsert_email(mem_db, user_id="jerome", folder="INBOX", msg=msg, now=NOW)
    id2 = upsert_email(mem_db, user_id="jerome", folder="INBOX", msg=msg, now=LATER)
    assert id1 == id2


def test_upsert_email_bumps_last_seen_at(mem_db):
    msg = _email()
    upsert_email(mem_db, user_id="jerome", folder="INBOX", msg=msg, now=NOW)
    upsert_email(mem_db, user_id="jerome", folder="INBOX", msg=msg, now=LATER)
    row = mem_db.execute(
        "SELECT first_seen_at, last_seen_at FROM emails"
    ).fetchone()
    assert row["first_seen_at"] == NOW.isoformat()
    assert row["last_seen_at"] == LATER.isoformat()


def test_upsert_email_rejects_naive_date(mem_db):
    msg = _email(date=datetime(2026, 5, 20, 12, 0, 0))  # naive
    with pytest.raises(ValueError, match="tz-aware"):
        upsert_email(mem_db, user_id="jerome", folder="INBOX", msg=msg, now=NOW)


def test_upsert_email_rejects_empty_message_id(mem_db):
    msg = _email(message_id="")
    with pytest.raises(sqlite3.IntegrityError):
        upsert_email(mem_db, user_id="jerome", folder="INBOX", msg=msg, now=NOW)


def test_upsert_email_per_user_isolation(mem_db):
    msg = _email()
    a = upsert_email(mem_db, user_id="jerome", folder="INBOX", msg=msg, now=NOW)
    b = upsert_email(mem_db, user_id="partner", folder="INBOX", msg=msg, now=NOW)
    assert a != b


# --- find_classification / insert_classification(_error) ---------------------

def _email_id(mem_db) -> int:
    return upsert_email(
        mem_db, user_id="jerome", folder="INBOX", msg=_email(), now=NOW
    )


def test_find_classification_returns_none_when_missing(mem_db):
    eid = _email_id(mem_db)
    assert find_classification(
        mem_db, email_id=eid, model="m", prompt_version="v"
    ) is None


def test_find_classification_returns_decoded_dict(mem_db):
    eid = _email_id(mem_db)
    insert_classification(
        mem_db,
        email_id=eid,
        run_id=None,
        model="m",
        prompt_version="v",
        result=_classification(),
        truncated=False,
        now=NOW,
    )
    found = find_classification(mem_db, email_id=eid, model="m", prompt_version="v")
    assert found is not None
    assert found["category"] == "daycare"
    assert found["priority"] == "low"
    assert found["action_required"] is True
    assert found["action_items"] == ["foo"]
    assert found["dates"] == ["2026-05-20"]
    assert found["confidence"] == 0.9


def test_find_classification_ignores_error_rows(mem_db):
    eid = _email_id(mem_db)
    insert_classification_error(
        mem_db,
        email_id=eid,
        run_id=None,
        model="m",
        prompt_version="v",
        error="boom",
        truncated=False,
        now=NOW,
    )
    assert find_classification(
        mem_db, email_id=eid, model="m", prompt_version="v"
    ) is None


def test_multiple_error_rows_allowed_for_retries(mem_db):
    eid = _email_id(mem_db)
    insert_classification_error(
        mem_db,
        email_id=eid,
        run_id=None,
        model="m",
        prompt_version="v",
        error="first",
        truncated=False,
        now=NOW,
    )
    insert_classification_error(
        mem_db,
        email_id=eid,
        run_id=None,
        model="m",
        prompt_version="v",
        error="second",
        truncated=False,
        now=LATER,
    )
    n = mem_db.execute(
        "SELECT count(*) AS n FROM classifications WHERE error IS NOT NULL"
    ).fetchone()["n"]
    assert n == 2


def test_second_successful_classification_rejected_by_partial_unique(mem_db):
    eid = _email_id(mem_db)
    insert_classification(
        mem_db,
        email_id=eid,
        run_id=None,
        model="m",
        prompt_version="v",
        result=_classification(),
        truncated=False,
        now=NOW,
    )
    with pytest.raises(sqlite3.IntegrityError):
        insert_classification(
            mem_db,
            email_id=eid,
            run_id=None,
            model="m",
            prompt_version="v",
            result=_classification(category=Category.other),
            truncated=False,
            now=LATER,
        )


def test_success_then_different_prompt_version_allowed(mem_db):
    eid = _email_id(mem_db)
    insert_classification(
        mem_db, email_id=eid, run_id=None,
        model="m", prompt_version="v1",
        result=_classification(), truncated=False, now=NOW,
    )
    insert_classification(
        mem_db, email_id=eid, run_id=None,
        model="m", prompt_version="v2",
        result=_classification(category=Category.other), truncated=False, now=LATER,
    )
    # Both rows present, each retrievable for its own version
    assert find_classification(
        mem_db, email_id=eid, model="m", prompt_version="v1"
    )["category"] == "daycare"
    assert find_classification(
        mem_db, email_id=eid, model="m", prompt_version="v2"
    )["category"] == "other"


# --- runs --------------------------------------------------------------------

def test_runs_roundtrip(mem_db):
    run_id = start_run(
        mem_db,
        user_id="jerome",
        args={"hours": 24, "limit": 200},
        model="m",
        prompt_version="v",
        hours=24,
        limit_n=200,
        now=NOW,
    )
    assert run_id is not None
    finish_run(
        mem_db,
        run_id=run_id,
        fetched=8,
        filtered=1,
        classified=1,
        reused=0,
        errors=0,
        truncated=1,
        now=LATER,
    )
    row = mem_db.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert row["fetched"] == 8
    assert row["filtered"] == 1
    assert row["classified"] == 1
    assert row["reused"] == 0
    assert row["truncated"] == 1
    assert row["started_at"] == NOW.isoformat()
    assert row["ended_at"] == LATER.isoformat()

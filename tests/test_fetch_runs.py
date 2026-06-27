"""Unit tests for app.db.fetch_runs.

Covers: newest-first ordering, limit, args exclusion, user scoping,
and SELECT-only behaviour (callable on a read-only connection).
"""
import sqlite3
from datetime import datetime, timezone

import pytest

import app.db as db
from app.db import fetch_runs
from app.cli_common import connect_db_ro


def _insert_run(conn: sqlite3.Connection, *, user_id: str, started_at: str) -> int:
    cur = conn.execute(
        """INSERT INTO runs (user_id, started_at, model, prompt_version, args,
               fetched, filtered, classified, reused, errors, truncated)
           VALUES (?, ?, 'model', 'v1', '{"key": "secret"}', 1, 0, 1, 0, 0, 0)""",
        (user_id, started_at),
    )
    conn.commit()
    return cur.lastrowid


# ---------------------------------------------------------------------------
# Basic cases
# ---------------------------------------------------------------------------

def test_fetch_runs_empty(mem_db):
    assert fetch_runs(mem_db, user_id="jerome") == []


def test_fetch_runs_returns_expected_keys(mem_db):
    now = datetime.now(timezone.utc).isoformat()
    _insert_run(mem_db, user_id="jerome", started_at=now)
    rows = fetch_runs(mem_db, user_id="jerome")
    assert len(rows) == 1
    expected_keys = {
        "id", "user_id", "started_at", "ended_at", "hours", "limit_n",
        "model", "prompt_version", "fetched", "filtered", "classified",
        "reused", "errors", "truncated",
    }
    assert set(rows[0].keys()) == expected_keys


def test_fetch_runs_args_excluded(mem_db):
    now = datetime.now(timezone.utc).isoformat()
    _insert_run(mem_db, user_id="jerome", started_at=now)
    rows = fetch_runs(mem_db, user_id="jerome")
    assert "args" not in rows[0]


# ---------------------------------------------------------------------------
# Ordering
# ---------------------------------------------------------------------------

def test_fetch_runs_newest_first(mem_db):
    t1 = "2024-01-01T10:00:00+00:00"
    t2 = "2024-01-01T11:00:00+00:00"
    t3 = "2024-01-01T12:00:00+00:00"
    for ts in [t1, t3, t2]:  # intentionally out of order
        _insert_run(mem_db, user_id="jerome", started_at=ts)

    rows = fetch_runs(mem_db, user_id="jerome")
    assert [r["started_at"] for r in rows] == [t3, t2, t1]


# ---------------------------------------------------------------------------
# Limit
# ---------------------------------------------------------------------------

def test_fetch_runs_default_limit_is_20(mem_db):
    for i in range(25):
        _insert_run(mem_db, user_id="jerome", started_at=f"2024-01-{i+1:02d}T00:00:00+00:00")
    rows = fetch_runs(mem_db, user_id="jerome")
    assert len(rows) == 20


def test_fetch_runs_explicit_limit(mem_db):
    for i in range(5):
        _insert_run(mem_db, user_id="jerome", started_at=f"2024-01-0{i+1}T00:00:00+00:00")
    rows = fetch_runs(mem_db, user_id="jerome", limit=3)
    assert len(rows) == 3


def test_fetch_runs_limit_returns_newest(mem_db):
    t1 = "2024-01-01T10:00:00+00:00"
    t2 = "2024-01-01T11:00:00+00:00"
    t3 = "2024-01-01T12:00:00+00:00"
    for ts in [t1, t2, t3]:
        _insert_run(mem_db, user_id="jerome", started_at=ts)
    rows = fetch_runs(mem_db, user_id="jerome", limit=2)
    assert [r["started_at"] for r in rows] == [t3, t2]


# ---------------------------------------------------------------------------
# User scoping
# ---------------------------------------------------------------------------

def test_fetch_runs_user_scoped(mem_db):
    now = datetime.now(timezone.utc).isoformat()
    _insert_run(mem_db, user_id="alice", started_at=now)
    _insert_run(mem_db, user_id="bob", started_at=now)
    rows = fetch_runs(mem_db, user_id="alice")
    assert len(rows) == 1
    assert rows[0]["user_id"] == "alice"


# ---------------------------------------------------------------------------
# SELECT-only: callable on a read-only connection
# ---------------------------------------------------------------------------

def test_fetch_runs_select_only(tmp_path):
    """fetch_runs succeeds on a read-only connection (no hidden writes)."""
    db_path = tmp_path / "kin.sqlite"
    conn = db.connect(str(db_path))
    _insert_run(conn, user_id="jerome", started_at="2024-01-01T12:00:00+00:00")
    conn.close()

    ro_conn = connect_db_ro(db_path, expected_schema_version=db.SCHEMA_VERSION)
    try:
        rows = fetch_runs(ro_conn, user_id="jerome")
        assert len(rows) == 1
        assert rows[0]["user_id"] == "jerome"
    finally:
        ro_conn.close()

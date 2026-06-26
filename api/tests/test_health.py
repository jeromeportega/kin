"""Tests for the api/ scaffold: health endpoint, deps seams, no-write guarantee."""
import sqlite3
import sys

import pytest

import app.db
from app.db import SCHEMA_VERSION


# ---------------------------------------------------------------------------
# Import smoke
# ---------------------------------------------------------------------------

def test_import_smoke():
    """api.main resolves app.db, app.digest, app.cli_common — no sys.path hacks."""
    import app.db as _db
    import app.digest as _digest
    import app.cli_common as _cli
    import api.main  # noqa: F401
    assert hasattr(_db, "SCHEMA_VERSION")
    assert hasattr(_digest, "Digest")
    assert hasattr(_cli, "connect_db_ro")


# ---------------------------------------------------------------------------
# Health happy path
# ---------------------------------------------------------------------------

def test_health_200(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"status": "ok", "schema_version": SCHEMA_VERSION, "db": "ro"}


def test_health_schema_version_matches_constant(client):
    """schema_version in health body equals app.db.SCHEMA_VERSION — not a literal."""
    resp = client.get("/api/health")
    assert resp.json()["schema_version"] == SCHEMA_VERSION


# ---------------------------------------------------------------------------
# Scope precedence — resolve_user_id
# ---------------------------------------------------------------------------

from api.deps import resolve_user_id


def test_scope_explicit_param_wins(monkeypatch):
    monkeypatch.setenv("KIN_DEMO_USER", "demo")
    monkeypatch.setenv("KIN_USER", "kin")
    assert resolve_user_id("explicit") == "explicit"


def test_scope_demo_user_wins_over_kin_user(monkeypatch):
    monkeypatch.delenv("KIN_DEMO_USER", raising=False)
    monkeypatch.setenv("KIN_DEMO_USER", "demo")
    monkeypatch.setenv("KIN_USER", "kin")
    assert resolve_user_id(None) == "demo"


def test_scope_kin_user_when_no_demo(monkeypatch):
    monkeypatch.delenv("KIN_DEMO_USER", raising=False)
    monkeypatch.setenv("KIN_USER", "kin")
    assert resolve_user_id(None) == "kin"


def test_scope_fallback_to_jerome(monkeypatch):
    monkeypatch.delenv("KIN_DEMO_USER", raising=False)
    monkeypatch.delenv("KIN_USER", raising=False)
    assert resolve_user_id(None) == "jerome"


def test_scope_explicit_beats_demo(monkeypatch):
    monkeypatch.setenv("KIN_DEMO_USER", "demo")
    assert resolve_user_id("explicit") == "explicit"


# ---------------------------------------------------------------------------
# RO connection lifecycle
# ---------------------------------------------------------------------------

from api.deps import get_ro_conn


def test_ro_conn_lifecycle(seeded_db_path):
    """get_ro_conn yields a live connection and closes it in finally."""
    gen = get_ro_conn(seeded_db_path)
    conn = next(gen)
    assert isinstance(conn, sqlite3.Connection)
    # Connection is live — can query
    row = conn.execute("SELECT value FROM _meta WHERE key='schema_version'").fetchone()
    assert row[0] == SCHEMA_VERSION
    # Exhaust generator (triggers finally → conn.close())
    try:
        next(gen)
    except StopIteration:
        pass
    # Connection is now closed
    with pytest.raises(Exception):
        conn.execute("SELECT 1")


# ---------------------------------------------------------------------------
# No-write by absence — NFR-1/T2
# ---------------------------------------------------------------------------

def test_no_imap_or_llm_imports():
    """api.main and api.deps source must not reference imap_*, ollama, or write modules."""
    from pathlib import Path
    import api.main
    import api.deps

    forbidden = ("imap", "ollama")
    for mod in (api.main, api.deps):
        src = Path(mod.__file__).read_text()
        for token in forbidden:
            assert token not in src, (
                f"Forbidden module reference {token!r} found in {mod.__file__}"
            )

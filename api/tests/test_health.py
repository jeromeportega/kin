"""Tests for the api/ scaffold: health endpoint, deps seams, no-write guarantee."""
import inspect
import pkgutil
import sqlite3

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
# Scope precedence — resolve_user_id unit tests
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
# Scope precedence — HTTP-level wiring via /api/scope
# ---------------------------------------------------------------------------

def test_scope_http_explicit_param(client, monkeypatch):
    """`?user_id=` query param reaches resolve_user_id via FastAPI Depends wiring."""
    monkeypatch.delenv("KIN_DEMO_USER", raising=False)
    monkeypatch.delenv("KIN_USER", raising=False)
    resp = client.get("/api/scope?user_id=alice")
    assert resp.status_code == 200
    assert resp.json()["user_id"] == "alice"


def test_scope_http_demo_user(client, monkeypatch):
    """`$KIN_DEMO_USER` is used when no query param is provided."""
    monkeypatch.delenv("KIN_DEMO_USER", raising=False)
    monkeypatch.setenv("KIN_DEMO_USER", "demouser")
    resp = client.get("/api/scope")
    assert resp.status_code == 200
    assert resp.json()["user_id"] == "demouser"


def test_scope_http_kin_user(client, monkeypatch):
    """`$KIN_USER` is used when no query param or KIN_DEMO_USER."""
    monkeypatch.delenv("KIN_DEMO_USER", raising=False)
    monkeypatch.delenv("KIN_USER", raising=False)
    monkeypatch.setenv("KIN_USER", "kinuser")
    resp = client.get("/api/scope")
    assert resp.status_code == 200
    assert resp.json()["user_id"] == "kinuser"


def test_scope_http_fallback(client, monkeypatch):
    """Falls back to 'jerome' when no env vars or query param."""
    monkeypatch.delenv("KIN_DEMO_USER", raising=False)
    monkeypatch.delenv("KIN_USER", raising=False)
    resp = client.get("/api/scope")
    assert resp.status_code == 200
    assert resp.json()["user_id"] == "jerome"


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
    # Connection is now closed — sqlite3 raises ProgrammingError on a closed connection
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


# ---------------------------------------------------------------------------
# No-write by absence — NFR-1/T2
# ---------------------------------------------------------------------------

def test_no_imap_or_llm_imports():
    """api.main, api.deps, and all api.routers source must not reference imap_* or ollama."""
    import api.main
    import api.deps
    import api.routers

    forbidden = ("imap", "ollama")

    # Collect modules: main, deps, and every discovered router
    modules_to_check = [api.main, api.deps]
    for _info in pkgutil.iter_modules(api.routers.__path__):
        import importlib
        mod = importlib.import_module(f"api.routers.{_info.name}")
        modules_to_check.append(mod)

    for mod in modules_to_check:
        # inspect.getsource resolves to the .py source regardless of __file__ value
        src = inspect.getsource(mod)
        for token in forbidden:
            assert token not in src, (
                f"Forbidden module reference {token!r} found in {mod.__name__}"
            )

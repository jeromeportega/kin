"""Tests for the api/ scaffold: health endpoint, deps seams, no-write guarantee."""
import inspect
import pkgutil
import sqlite3

import pytest

import app.db
from app.db import SCHEMA_VERSION
from api.deps import DEFAULT_KIN_USER


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


def test_scope_fallback_to_default(monkeypatch):
    monkeypatch.delenv("KIN_DEMO_USER", raising=False)
    monkeypatch.delenv("KIN_USER", raising=False)
    assert resolve_user_id(None) == DEFAULT_KIN_USER


def test_scope_explicit_beats_demo(monkeypatch):
    monkeypatch.setenv("KIN_DEMO_USER", "demo")
    assert resolve_user_id("explicit") == "explicit"


# ---------------------------------------------------------------------------
# resolve_db_path validation
# ---------------------------------------------------------------------------

from api.deps import resolve_db_path


def test_resolve_db_path_default(monkeypatch):
    """Default path is data/kin.sqlite when KIN_DB_PATH is unset."""
    monkeypatch.delenv("KIN_DB_PATH", raising=False)
    p = resolve_db_path()
    assert p.name == "kin.sqlite"


def test_resolve_db_path_custom(monkeypatch, tmp_path):
    """KIN_DB_PATH with a .sqlite extension is accepted."""
    db = tmp_path / "custom.sqlite"
    db.touch()
    monkeypatch.setenv("KIN_DB_PATH", str(db))
    assert resolve_db_path() == db.resolve()


def test_resolve_db_path_rejects_bad_extension(monkeypatch, tmp_path):
    """KIN_DB_PATH pointing to a non-db file is rejected at resolution time."""
    bad = tmp_path / "secrets.txt"
    bad.touch()
    monkeypatch.setenv("KIN_DB_PATH", str(bad))
    with pytest.raises(ValueError, match=r"\.sqlite or \.db"):
        resolve_db_path()


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

def test_no_forbidden_imports():
    """api.main, api.deps, and all api.routers source must not reference
    write-path, IMAP, or LLM modules."""
    import api.main
    import api.deps
    import api.routers

    forbidden = ("imap", "imaplib", "ollama", "openai", "anthropic", "smtplib")

    # Collect modules: main, deps, and every discovered router
    modules_to_check = [api.main, api.deps]
    for _info in pkgutil.iter_modules(api.routers.__path__):
        import importlib
        mod = importlib.import_module(f"api.routers.{_info.name}")
        modules_to_check.append(mod)

    for mod in modules_to_check:
        src = inspect.getsource(mod)
        for token in forbidden:
            assert token not in src, (
                f"Forbidden module reference {token!r} found in {mod.__name__}"
            )

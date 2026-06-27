"""The env-conditional config/token source: DB when TURSO_DATABASE_URL is set
(production / Vercel), the local file otherwise (dev + tests)."""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app import db
from app.config import load_effective_config
from ingest.token_store import read_effective_refresh_token


def _mem_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    db.init_schema(conn)
    return conn


def test_config_uses_file_without_turso(tmp_path, monkeypatch):
    monkeypatch.delenv("TURSO_DATABASE_URL", raising=False)
    p = tmp_path / "kin.toml"
    p.write_text('[filters]\nsender_allowlist = ["a@x.com"]\n')
    assert load_effective_config("jerome", p).sender_allowlist == ["a@x.com"]


def test_config_uses_db_with_turso(monkeypatch):
    conn = _mem_conn()
    db.add_filter_entries(conn, user_id="jerome", kind="sender_allowlist", values=["db@x.com"])
    conn.commit()
    monkeypatch.setenv("TURSO_DATABASE_URL", "libsql://fake")
    monkeypatch.setattr(db, "connect", lambda path: conn)
    assert load_effective_config("jerome", "ignored.toml").sender_allowlist == ["db@x.com"]


def test_token_uses_file_without_turso(tmp_path, monkeypatch):
    monkeypatch.delenv("TURSO_DATABASE_URL", raising=False)
    p = tmp_path / "tokens.json"
    p.write_text(json.dumps({"me@x.com": {"refresh_token": "filetok"}}))
    assert read_effective_refresh_token("me@x.com", path=p) == "filetok"


def test_token_uses_db_with_turso(monkeypatch):
    conn = _mem_conn()
    db.write_refresh_token(
        conn, email="me@x.com", refresh_token="dbtok", scope="s", now=datetime.now(timezone.utc)
    )
    conn.commit()
    monkeypatch.setenv("TURSO_DATABASE_URL", "libsql://fake")
    monkeypatch.setattr(db, "connect", lambda path: conn)
    assert read_effective_refresh_token("me@x.com", path=Path("ignored.json")) == "dbtok"

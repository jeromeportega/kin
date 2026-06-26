"""End-to-end CLI tests for app.digest.main()."""
import json
import sqlite3
import sys
from datetime import datetime, timezone

import pytest

from app import digest as digest_mod
from app.db import connect, insert_classification, upsert_email
from app.email_source import FetchedEmail
from app.schemas.email import Category, EmailClassification, Priority

T0 = datetime(2026, 5, 20, 12, 0, 0, tzinfo=timezone.utc)
# Freeze "now" a few hours after the seeded email so the digest's default 24h
# window always contains T0. Without this, these tests silently start failing
# once the real clock drifts past T0 + window.
_NOW = datetime(2026, 5, 20, 18, 0, 0, tzinfo=timezone.utc)


def _email(msg_id="<a@x>") -> FetchedEmail:
    return FetchedEmail(
        uid="1", message_id=msg_id,
        from_addr="s@example.com",
        to_addrs=("you@example.com",), cc_addrs=(),
        subject="subj", date=T0,
        text_body="body", truncated=False,
    )


def _seed_db(db_path, category, priority, action, msg_id="<a@x>"):
    conn = connect(db_path)
    try:
        eid = upsert_email(
            conn, user_id="jerome", folder="INBOX",
            msg=_email(msg_id), now=T0,
        )
        insert_classification(
            conn, email_id=eid, run_id=None,
            model="qwen3:14b", prompt_version="abc",
            result=EmailClassification(
                category=category, priority=priority, action_required=action,
                summary="s",
                action_items=["x"] if action else [],
                dates=[],
                confidence=0.9,
            ),
            truncated=False, now=T0,
        )
        conn.commit()
    finally:
        conn.close()


def _setup_env(monkeypatch, tmp_path):
    db_path = tmp_path / "kin.sqlite"
    monkeypatch.setenv("KIN_DB_PATH", str(db_path))
    monkeypatch.setattr("app.digest.load_dotenv", lambda *a, **kw: None)
    return db_path


def _run(monkeypatch, *argv) -> int:
    monkeypatch.setattr(sys, "argv", ["app.digest", *argv])
    monkeypatch.setattr(digest_mod, "_utcnow", lambda: _NOW)
    return digest_mod.main()


def test_main_default_writes_markdown_to_stdout_and_persists(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, Category.daycare, Priority.low, True)

    rc = _run(monkeypatch)
    assert rc == 0

    out = capsys.readouterr().out
    assert out.startswith("# kin daily digest")
    assert "daycare" in out

    conn = sqlite3.connect(str(db_path))
    try:
        n = conn.execute("SELECT COUNT(*) FROM digests").fetchone()[0]
        items = conn.execute("SELECT COUNT(*) FROM digest_items").fetchone()[0]
    finally:
        conn.close()
    assert n == 1
    assert items == 1


def test_main_no_persist_skips_table_writes(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, Category.daycare, Priority.low, True)

    rc = _run(monkeypatch, "--no-persist")
    assert rc == 0
    capsys.readouterr()  # discard

    conn = sqlite3.connect(str(db_path))
    try:
        n = conn.execute("SELECT COUNT(*) FROM digests").fetchone()[0]
    finally:
        conn.close()
    assert n == 0


def test_main_out_md_writes_file_keeps_stdout(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, Category.daycare, Priority.low, True)
    out_path = tmp_path / "digest.md"

    rc = _run(monkeypatch, "--out-md", str(out_path))
    assert rc == 0
    out = capsys.readouterr().out
    assert out.startswith("# kin daily digest")
    assert out_path.exists()
    assert out_path.read_text().startswith("# kin daily digest")


def test_main_out_json_writes_file_stdout_remains_markdown(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, Category.daycare, Priority.low, True)
    out_path = tmp_path / "digest.json"

    rc = _run(monkeypatch, "--out-json", str(out_path))
    assert rc == 0
    out = capsys.readouterr().out
    assert out.startswith("# kin daily digest")
    assert out_path.exists()
    parsed = json.loads(out_path.read_text())
    assert parsed["user_id"] == "jerome"


def test_main_out_json_dash_routes_json_to_stdout(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, Category.daycare, Priority.low, True)

    rc = _run(monkeypatch, "--out-json", "-")
    assert rc == 0
    out = capsys.readouterr().out
    # JSON went to stdout instead of markdown
    parsed = json.loads(out)
    assert parsed["user_id"] == "jerome"


def test_main_include_other_groups_other_items(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, Category.other, Priority.low, True)

    # Default: skipped from groups, surfaced as a skipped count
    rc = _run(monkeypatch)
    assert rc == 0
    out = capsys.readouterr().out
    assert "## Skipped" in out

    # With --include-other: appears in groups
    rc = _run(monkeypatch, "--include-other")
    assert rc == 0
    out = capsys.readouterr().out
    assert "### other" in out


def test_main_db_missing_with_no_persist_returns_exit_db(monkeypatch, tmp_path):
    monkeypatch.setenv("KIN_DB_PATH", str(tmp_path / "nonexistent.sqlite"))
    monkeypatch.setattr("app.digest.load_dotenv", lambda *a, **kw: None)
    rc = _run(monkeypatch, "--no-persist")
    assert rc == 5  # EXIT_DB

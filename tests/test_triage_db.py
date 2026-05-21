"""End-to-end Phase 3 integration test.

Drives `app.triage.main()` against a fake `EmailSource` and a stubbed
`classify`, then asserts the DB state across a sequence of runs (cache
hits, --force-reclassify, --no-db, prompt-version invalidation, dry-run).
No IMAP, no Ollama.
"""
import json
import sqlite3
import sys
from datetime import datetime, timezone
from typing import Iterator

from app import triage as triage_mod
from app.email_source import FetchedEmail
from app.schemas.email import Category, EmailClassification, Priority


def _msg(message_id: str, subject: str, uid: str | None = None) -> FetchedEmail:
    return FetchedEmail(
        uid=uid or message_id.strip("<>").split("@")[0],
        message_id=message_id,
        from_addr="sender@example.com",
        to_addrs=("you@example.com",),
        cc_addrs=(),
        subject=subject,
        date=datetime(2026, 5, 20, 14, 0, 0, tzinfo=timezone.utc),
        text_body=f"body for {subject}",
        truncated=False,
    )


_FAKE_EMAILS = [
    _msg("<a@x>", "appointment with the pediatrician"),
    _msg("<b@x>", "your bill is due"),
]


class FakeSource:
    """Test double for IMAPSource. Replays a fixed list."""

    def __init__(self, *args, **kwargs):
        self._emails = list(_FAKE_EMAILS)

    def fetch_recent(self, *, hours: int, limit: int) -> Iterator[FetchedEmail]:
        return iter(self._emails[:limit])


def _stub_classify(text: str, model: str) -> EmailClassification:
    return EmailClassification(
        category=Category.other,
        priority=Priority.low,
        action_required=False,
        summary="stub classification",
        action_items=[],
        dates=[],
        confidence=0.5,
    )


def _setup_env(monkeypatch, tmp_path):
    """Configure env, stubs, and a kin.toml. Returns the config file path."""
    monkeypatch.setenv("IMAP_HOST", "imap.example.com")
    monkeypatch.setenv("IMAP_PORT", "993")
    monkeypatch.setenv("GMAIL_ADDRESS", "you@example.com")
    monkeypatch.setenv("GMAIL_APP_PASSWORD", "test-pw")
    monkeypatch.setenv("KIN_DB_PATH", str(tmp_path / "kin.sqlite"))

    # Block the real .env from polluting our test env.
    monkeypatch.setattr("app.triage.load_dotenv", lambda *a, **kw: None)
    monkeypatch.setattr("app.triage.IMAPSource", FakeSource)
    monkeypatch.setattr("app.triage.classify", _stub_classify)

    cfg_path = tmp_path / "kin.toml"
    cfg_path.write_text(
        '[filters]\n'
        'sender_allowlist = ["@example.com"]\n'
        'sender_blocklist = []\n'
        'subject_keywords = []\n'
        'body_keywords = []\n'
    )
    return cfg_path


def _run(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["app.triage", *argv])
    return triage_mod.main()


def _runs(db_path):
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        return list(conn.execute("SELECT * FROM runs ORDER BY id"))
    finally:
        conn.close()


def _count(db_path, table, where: str = "1=1") -> int:
    conn = sqlite3.connect(str(db_path))
    try:
        return conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}").fetchone()[0]
    finally:
        conn.close()


# --- happy path: cache miss then cache hit -----------------------------------

def test_first_run_classifies_then_second_run_reuses(monkeypatch, tmp_path, capsys):
    cfg_path = _setup_env(monkeypatch, tmp_path)
    db_path = tmp_path / "kin.sqlite"

    assert _run(monkeypatch, "--config", str(cfg_path)) == 0
    runs = _runs(db_path)
    assert len(runs) == 1
    assert runs[0]["fetched"] == 2
    assert runs[0]["filtered"] == 2
    assert runs[0]["classified"] == 2
    assert runs[0]["reused"] == 0
    assert runs[0]["errors"] == 0
    assert runs[0]["ended_at"] is not None

    out1 = capsys.readouterr().out.strip().splitlines()
    assert len(out1) == 2
    assert all(json.loads(line)["source"] == "classifier" for line in out1)
    assert _count(db_path, "emails") == 2
    assert _count(db_path, "classifications", "error IS NULL") == 2

    # Second run — same prompt, should be all cache hits
    assert _run(monkeypatch, "--config", str(cfg_path)) == 0
    runs = _runs(db_path)
    assert len(runs) == 2
    assert runs[1]["classified"] == 0
    assert runs[1]["reused"] == 2

    out2 = capsys.readouterr().out.strip().splitlines()
    assert len(out2) == 2
    assert all(json.loads(line)["source"] == "db" for line in out2)
    # Still only 2 emails, still only 2 successful classifications
    assert _count(db_path, "emails") == 2
    assert _count(db_path, "classifications", "error IS NULL") == 2


def test_force_reclassify_bypasses_cache(monkeypatch, tmp_path, capsys):
    cfg_path = _setup_env(monkeypatch, tmp_path)
    db_path = tmp_path / "kin.sqlite"

    _run(monkeypatch, "--config", str(cfg_path))
    capsys.readouterr()

    # --force-reclassify should attempt to insert again, which the partial
    # unique index will reject; triage swallows the DB error as a warning
    # and still emits the classification. We assert it counted as a fresh
    # classification regardless.
    assert _run(monkeypatch, "--config", str(cfg_path), "--force-reclassify") == 0
    runs = _runs(db_path)
    assert runs[-1]["classified"] == 2
    assert runs[-1]["reused"] == 0

    out = capsys.readouterr().out.strip().splitlines()
    assert all(json.loads(line)["source"] == "classifier" for line in out)


def test_no_db_skips_persistence(monkeypatch, tmp_path, capsys):
    cfg_path = _setup_env(monkeypatch, tmp_path)
    db_path = tmp_path / "kin.sqlite"

    assert _run(monkeypatch, "--config", str(cfg_path), "--no-db") == 0
    assert not db_path.exists()

    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 2
    assert all(json.loads(line)["source"] == "classifier" for line in out)


def test_prompt_version_change_invalidates_cache(monkeypatch, tmp_path, capsys):
    cfg_path = _setup_env(monkeypatch, tmp_path)
    db_path = tmp_path / "kin.sqlite"

    _run(monkeypatch, "--config", str(cfg_path))
    capsys.readouterr()

    # Simulate a prompt change by patching the module-level constant.
    monkeypatch.setattr("app.triage.PROMPT_VERSION", "different_version_hash_xyz")

    assert _run(monkeypatch, "--config", str(cfg_path)) == 0
    runs = _runs(db_path)
    # The new prompt version means cache misses → fresh classifications
    assert runs[-1]["classified"] == 2
    assert runs[-1]["reused"] == 0

    out = capsys.readouterr().out.strip().splitlines()
    assert all(json.loads(line)["source"] == "classifier" for line in out)
    # We now have 4 classification rows: 2 for the old version, 2 for the new
    assert _count(db_path, "classifications", "error IS NULL") == 4


def test_dry_run_emits_filter_source_and_skips_classification(monkeypatch, tmp_path, capsys):
    cfg_path = _setup_env(monkeypatch, tmp_path)
    db_path = tmp_path / "kin.sqlite"

    assert _run(monkeypatch, "--config", str(cfg_path), "--dry-run") == 0
    # Dry-run still opens the DB and writes a run row, but no emails or
    # classifications are touched.
    assert _count(db_path, "runs") == 1
    assert _count(db_path, "emails") == 0
    assert _count(db_path, "classifications") == 0

    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 2
    assert all(json.loads(line)["source"] == "filter" for line in out)


def test_classification_failure_writes_error_row_and_retries_next_run(monkeypatch, tmp_path, capsys):
    cfg_path = _setup_env(monkeypatch, tmp_path)
    db_path = tmp_path / "kin.sqlite"

    calls = {"n": 0}

    def flaky_classify(text, model):
        calls["n"] += 1
        # Fail on every call during this test
        raise RuntimeError("simulated model failure")

    monkeypatch.setattr("app.triage.classify", flaky_classify)

    rc = _run(monkeypatch, "--config", str(cfg_path))
    # All filtered emails errored → triage returns EXIT_MODEL (4)
    assert rc == 4
    runs = _runs(db_path)
    assert runs[-1]["errors"] == 2
    assert runs[-1]["classified"] == 0

    out = capsys.readouterr().out.strip().splitlines()
    assert all(json.loads(line)["source"] == "error" for line in out)
    assert _count(db_path, "classifications", "error IS NOT NULL") == 2

    # Restore the working classifier; re-run should retry, not skip
    monkeypatch.setattr("app.triage.classify", _stub_classify)
    assert _run(monkeypatch, "--config", str(cfg_path)) == 0
    runs = _runs(db_path)
    assert runs[-1]["classified"] == 2
    assert runs[-1]["reused"] == 0

    out = capsys.readouterr().out.strip().splitlines()
    assert all(json.loads(line)["source"] == "classifier" for line in out)
    # 2 successful + 2 error rows from the first run
    assert _count(db_path, "classifications", "error IS NULL") == 2
    assert _count(db_path, "classifications", "error IS NOT NULL") == 2

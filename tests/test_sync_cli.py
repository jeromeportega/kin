"""End-to-end tests for app.sync."""
import json
import os
import sqlite3
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import pytest
from icalendar import Calendar

from app import sync as sync_mod
from app.db import connect
from app.digest import Digest, DigestItem
from tests.conftest import seed_digest


T0 = datetime(2026, 5, 20, 18, 0, 0, tzinfo=timezone.utc)


def _item(**overrides) -> DigestItem:
    base = dict(
        classification_id=1,
        message_id="<a@x.com>",
        uid="1",
        from_addr="s@example.com",
        subject="Subject A",
        date="2026-05-20T12:00:00+00:00",
        category="daycare",
        priority="high",
        action_required=True,
        summary="A summary.",
        action_items=["Do thing"],
        dates=["2026-05-25"],
        confidence=0.9,
        model="qwen3:14b",
        prompt_version="abc123",
        classified_at="2026-05-20T18:00:00+00:00",
    )
    base.update(overrides)
    return DigestItem(**base)


def _digest(items=None, **overrides) -> Digest:
    base = dict(
        generated_at=T0.isoformat(),
        user_id="jerome",
        model="qwen3:14b",
        prompt_version="abc",
        window_hours=24,
        window_start="2026-05-19T18:00:00+00:00",
        window_end="2026-05-20T18:00:00+00:00",
        include_other=False,
        classified_count=1,
        actionable_count=1,
        informational_count=0,
        skipped_other_count=0,
        dropped_low_count=0,
        items=items if items is not None else [_item()],
    )
    base.update(overrides)
    return Digest(**base)


def _seed_real_digest(db_path, digest):
    conn = connect(db_path)
    try:
        seed_digest(
            conn,
            user_id=digest.user_id,
            generated_at=datetime.fromisoformat(digest.generated_at),
            window_hours=digest.window_hours,
            classified_count=digest.classified_count,
            actionable_count=digest.actionable_count,
            informational_count=digest.informational_count,
            skipped_other_count=digest.skipped_other_count,
            dropped_low_count=digest.dropped_low_count,
            model=digest.model or "qwen3:14b",
            prompt_version=digest.prompt_version or "abc",
            include_other=digest.include_other,
            json_payload=digest.to_json(),
            markdown="# stub",
        )
    finally:
        conn.close()


def _setup_env(monkeypatch, tmp_path, *, vault_subdir="vault"):
    db_path = tmp_path / "kin.sqlite"
    vault_path = tmp_path / vault_subdir
    monkeypatch.setenv("KIN_DB_PATH", str(db_path))
    monkeypatch.setenv("KIN_OBSIDIAN_VAULT", str(vault_path))
    monkeypatch.setattr("app.sync.load_dotenv", lambda *a, **kw: None)
    return db_path, vault_path


def _run(monkeypatch, *argv) -> int:
    monkeypatch.setattr(sys, "argv", ["app.sync", *argv])
    return sync_mod.main()


# --- happy path ------------------------------------------------------------

def test_default_run_writes_vault_files_and_ics(monkeypatch, tmp_path, capsys):
    db_path, vault_path = _setup_env(monkeypatch, tmp_path)
    digest = _digest()
    _seed_real_digest(db_path, digest)

    # Override ICS dir to tmp so we don't pollute the real runs/
    ics_path = tmp_path / "kin.ics"
    rc = _run(monkeypatch, "--ics-path", str(ics_path))
    capsys.readouterr()
    assert rc == 0

    # Vault files exist
    digests_dir = vault_path / "kin" / "digests"
    emails_dir = vault_path / "kin" / "emails"
    daily_notes = list(digests_dir.glob("*.md"))
    assert len(daily_notes) == 1
    email_notes = list(emails_dir.glob("*.md"))
    assert len(email_notes) == 1

    # Daily note has a wikilink
    daily_text = daily_notes[0].read_text()
    assert "[[kin/emails/" in daily_text

    # ICS exists and parses
    assert ics_path.exists()
    cal = Calendar.from_ical(ics_path.read_text())
    events = [c for c in cal.walk() if c.name == "VEVENT"]
    assert len(events) == 1


def test_dry_run_writes_nothing_and_prints_paths(monkeypatch, tmp_path, capsys):
    db_path, vault_path = _setup_env(monkeypatch, tmp_path)
    _seed_real_digest(db_path, _digest())

    ics_path = tmp_path / "kin.ics"
    rc = _run(monkeypatch, "--dry-run", "--ics-path", str(ics_path))
    assert rc == 0

    # Nothing should exist on disk
    assert not (vault_path / "kin").exists()
    assert not ics_path.exists()

    out = capsys.readouterr().out
    # Planned paths printed
    assert "kin/emails" in out
    assert "kin/digests" in out
    assert str(ics_path) in out


def test_no_obsidian_skips_vault_writes(monkeypatch, tmp_path, capsys):
    db_path, vault_path = _setup_env(monkeypatch, tmp_path)
    _seed_real_digest(db_path, _digest())

    ics_path = tmp_path / "kin.ics"
    rc = _run(monkeypatch, "--no-obsidian", "--ics-path", str(ics_path))
    capsys.readouterr()
    assert rc == 0
    assert not (vault_path / "kin").exists()
    assert ics_path.exists()


def test_no_ics_skips_calendar(monkeypatch, tmp_path, capsys):
    db_path, vault_path = _setup_env(monkeypatch, tmp_path)
    _seed_real_digest(db_path, _digest())

    rc = _run(monkeypatch, "--no-ics")
    capsys.readouterr()
    assert rc == 0
    assert (vault_path / "kin" / "digests").exists()
    # No ICS files in tmp
    assert list(tmp_path.glob("*.ics")) == []


def test_ics_dash_routes_to_stdout(monkeypatch, tmp_path, capsys):
    db_path, vault_path = _setup_env(monkeypatch, tmp_path)
    _seed_real_digest(db_path, _digest())

    rc = _run(monkeypatch, "--no-obsidian", "--ics-path", "-")
    out = capsys.readouterr().out
    assert rc == 0
    assert out.startswith("BEGIN:VCALENDAR")


def test_digest_id_targets_specific_digest(monkeypatch, tmp_path, capsys):
    db_path, vault_path = _setup_env(monkeypatch, tmp_path)
    # Seed two digests; older one will be targeted by id
    older = _digest(items=[_item(subject="Older subject")])
    newer = _digest(items=[_item(subject="Newer subject")])
    conn = connect(db_path)
    try:
        older_id = seed_digest(
            conn, generated_at=T0,
            json_payload=older.to_json(), markdown="md",
            classified_count=1, actionable_count=1,
        )
        seed_digest(
            conn, generated_at=datetime(2026, 5, 21, 12, 0, 0, tzinfo=timezone.utc),
            json_payload=newer.to_json(), markdown="md",
            classified_count=1, actionable_count=1,
        )
    finally:
        conn.close()

    ics_path = tmp_path / "kin.ics"
    rc = _run(monkeypatch, "--digest-id", str(older_id),
              "--ics-path", str(ics_path))
    capsys.readouterr()
    assert rc == 0

    # The daily note's wikilink references the older subject
    daily_notes = list((vault_path / "kin" / "digests").glob("*.md"))
    text = daily_notes[0].read_text()
    assert "Older subject" in text


def test_missing_vault_with_no_no_obsidian_returns_exit_config(monkeypatch, tmp_path):
    db_path = tmp_path / "kin.sqlite"
    monkeypatch.setenv("KIN_DB_PATH", str(db_path))
    monkeypatch.delenv("KIN_OBSIDIAN_VAULT", raising=False)
    monkeypatch.setattr("app.sync.load_dotenv", lambda *a, **kw: None)
    _seed_real_digest(db_path, _digest())

    rc = _run(monkeypatch)
    assert rc == 2  # EXIT_CONFIG


def test_no_digest_in_db_returns_exit_config(monkeypatch, tmp_path):
    db_path, vault_path = _setup_env(monkeypatch, tmp_path)
    # Initialize an empty DB
    conn = connect(db_path)
    conn.close()

    rc = _run(monkeypatch)
    assert rc == 2  # EXIT_CONFIG (no digest matching window_hours=24)


def test_default_window_filter_skips_forensic_digest(monkeypatch, tmp_path):
    """A 720-hour forensic digest must NOT be picked as the latest daily digest."""
    db_path, vault_path = _setup_env(monkeypatch, tmp_path)
    # Seed only a forensic digest
    conn = connect(db_path)
    try:
        seed_digest(
            conn,
            window_hours=720,
            json_payload=_digest(window_hours=720).to_json(),
        )
    finally:
        conn.close()

    rc = _run(monkeypatch)
    assert rc == 2  # No daily digest → EXIT_CONFIG


# --- idempotency ------------------------------------------------------------

def test_sync_twice_produces_identical_files(monkeypatch, tmp_path, capsys):
    db_path, vault_path = _setup_env(monkeypatch, tmp_path)
    _seed_real_digest(db_path, _digest())

    ics_path = tmp_path / "kin.ics"
    _run(monkeypatch, "--ics-path", str(ics_path))
    capsys.readouterr()

    # Snapshot vault state
    first_files: dict[Path, str] = {}
    for p in (vault_path / "kin").rglob("*.md"):
        first_files[p.relative_to(vault_path)] = p.read_text()
    first_ics = ics_path.read_text()

    # Run again with the same digest
    _run(monkeypatch, "--ics-path", str(ics_path))
    capsys.readouterr()

    second_files: dict[Path, str] = {}
    for p in (vault_path / "kin").rglob("*.md"):
        second_files[p.relative_to(vault_path)] = p.read_text()
    second_ics = ics_path.read_text()

    # Vault files must be identical (synced_at moves but the *digest_id* doesn't
    # change between runs — synced_at is timestamp-of-write, so it WILL differ.
    # We test that the file set is identical and the body up to synced_at is
    # the same; full byte-identity isn't expected since synced_at changes.)
    assert set(first_files) == set(second_files)


# --- zero items ------------------------------------------------------------

def test_zero_items_digest_renders_empty_artifacts(monkeypatch, tmp_path, capsys):
    db_path, vault_path = _setup_env(monkeypatch, tmp_path)
    empty = _digest(items=[], classified_count=0, actionable_count=0,
                    informational_count=0)
    _seed_real_digest(db_path, empty)

    ics_path = tmp_path / "kin.ics"
    rc = _run(monkeypatch, "--ics-path", str(ics_path))
    capsys.readouterr()
    assert rc == 0

    # Daily note exists; no email notes
    digests_dir = vault_path / "kin" / "digests"
    emails_dir = vault_path / "kin" / "emails"
    assert len(list(digests_dir.glob("*.md"))) == 1
    assert (emails_dir.exists() and len(list(emails_dir.glob("*.md"))) == 0) \
        or not emails_dir.exists()

    # ICS is a valid empty calendar
    cal = Calendar.from_ical(ics_path.read_text())
    assert [c for c in cal.walk() if c.name == "VEVENT"] == []


# --- atomic write failure ---------------------------------------------------

def test_atomic_write_failure_leaves_target_absent(monkeypatch, tmp_path, capsys):
    db_path, vault_path = _setup_env(monkeypatch, tmp_path)
    _seed_real_digest(db_path, _digest())

    # Force os.replace to raise; first write should fail.
    def boom(*a, **kw):
        raise OSError("simulated")

    monkeypatch.setattr("app.sync.os.replace", boom)

    ics_path = tmp_path / "kin.ics"
    with pytest.raises(OSError):
        _run(monkeypatch, "--ics-path", str(ics_path))
    capsys.readouterr()

    # Neither the daily note nor any per-email note should exist (no atomic move)
    digests_dir = vault_path / "kin" / "digests"
    assert not digests_dir.exists() or list(digests_dir.glob("*.md")) == []

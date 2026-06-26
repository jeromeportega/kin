"""Tests for app.send."""
import email
import smtplib
import sqlite3
import sys
from datetime import datetime, timezone

import pytest

from app import db, send as send_mod
from app.db import connect
from app.digest import Digest, DigestItem
from app.exit_codes import EXIT_CONFIG, EXIT_OK, EXIT_UNEXPECTED
from tests.conftest import seed_digest


T0 = datetime(2026, 5, 20, 18, 0, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _item(**overrides) -> DigestItem:
    base = dict(
        classification_id=1,
        message_id="<a@x.com>",
        uid="1",
        from_addr="sender@example.com",
        subject="Action required: renew insurance",
        date="2026-05-20T12:00:00+00:00",
        category="finance",
        priority="high",
        action_required=True,
        summary="Your insurance policy is up for renewal.",
        action_items=["Renew by June 1"],
        dates=["2026-06-01"],
        confidence=0.95,
        model="qwen3:14b",
        prompt_version="abc123",
        classified_at="2026-05-20T18:00:00+00:00",
    )
    base.update(overrides)
    return DigestItem(**base)


def _digest(items=None, user_id="jerome", **overrides) -> Digest:
    base = dict(
        generated_at=T0.isoformat(),
        user_id=user_id,
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


def _seed_db(db_path, digest):
    """Seed a digest into a real SQLite file."""
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
            json_payload=digest.to_json(),
            markdown="# stub",
        )
    finally:
        conn.close()


def _setup_env(monkeypatch, tmp_path):
    db_path = tmp_path / "kin.sqlite"
    monkeypatch.setenv("KIN_DB_PATH", str(db_path))
    monkeypatch.setenv("GMAIL_ADDRESS", "sender@gmail.com")
    monkeypatch.setenv("GMAIL_APP_PASSWORD", "secret-app-password")
    monkeypatch.setenv("KIN_DIGEST_TO", "recipient@example.com")
    monkeypatch.delenv("SMTP_HOST", raising=False)
    monkeypatch.delenv("SMTP_PORT", raising=False)
    monkeypatch.setattr("app.send.load_dotenv", lambda *a, **kw: None)
    return db_path


def _run(monkeypatch, *argv) -> int:
    monkeypatch.setattr(sys, "argv", ["app.send", *argv])
    return send_mod.main()


# ---------------------------------------------------------------------------
# Fake SMTP that records calls
# ---------------------------------------------------------------------------


class FakeSMTP:
    """Records SMTP method calls for assertion; usable as a context manager."""

    instances: list["FakeSMTP"] = []

    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.calls: list[str] = []
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def starttls(self):
        self.calls.append("starttls")

    def login(self, user, password):
        self.calls.append(f"login:{user}")
        self._login_user = user
        self._login_password = password

    def send_message(self, msg):
        self.calls.append("send_message")
        self._sent_msg = msg


@pytest.fixture(autouse=True)
def _clear_fake_smtp_instances():
    """Reset FakeSMTP.instances before each test."""
    FakeSMTP.instances.clear()
    yield
    FakeSMTP.instances.clear()


# ---------------------------------------------------------------------------
# AC: dry-run — no socket, full RFC822 multipart/alternative printed
# ---------------------------------------------------------------------------


class _NeverInstantiate:
    def __init__(self, *args, **kwargs):
        raise AssertionError("smtplib.SMTP must NOT be instantiated under --dry-run")


def test_dry_run_no_smtp_full_message_printed(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, _digest())
    monkeypatch.setattr(smtplib, "SMTP", _NeverInstantiate)

    rc = _run(monkeypatch, "--dry-run")

    assert rc == EXIT_OK
    out = capsys.readouterr().out

    # Subject header must be present
    assert "Subject:" in out

    # Both parts must appear (multipart/alternative)
    assert "text/plain" in out
    assert "text/html" in out

    # text/plain part must come before text/html part
    plain_idx = out.index("text/plain")
    html_idx = out.index("text/html")
    assert plain_idx < html_idx, "text/plain part must precede text/html part"

    # App password must never appear in output
    assert "secret-app-password" not in out


def test_dry_run_no_smtp_empty_digest(monkeypatch, tmp_path, capsys):
    """An empty digest still produces a two-part message under --dry-run."""
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, _digest(items=[], actionable_count=0, classified_count=0))
    monkeypatch.setattr(smtplib, "SMTP", _NeverInstantiate)

    rc = _run(monkeypatch, "--dry-run")

    assert rc == EXIT_OK
    out = capsys.readouterr().out
    assert "Subject:" in out
    assert "text/plain" in out
    assert "text/html" in out


# ---------------------------------------------------------------------------
# AC: missing credentials → EXIT_CONFIG before any SMTP instantiation
# ---------------------------------------------------------------------------


def test_missing_gmail_address_returns_exit_config(monkeypatch, tmp_path):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, _digest())
    monkeypatch.delenv("GMAIL_ADDRESS")
    monkeypatch.setattr(smtplib, "SMTP", _NeverInstantiate)

    rc = _run(monkeypatch)

    assert rc == EXIT_CONFIG
    # _NeverInstantiate would have raised AssertionError if SMTP was called


def test_missing_gmail_app_password_returns_exit_config(monkeypatch, tmp_path):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, _digest())
    monkeypatch.delenv("GMAIL_APP_PASSWORD")
    monkeypatch.setattr(smtplib, "SMTP", _NeverInstantiate)

    rc = _run(monkeypatch)

    assert rc == EXIT_CONFIG


# ---------------------------------------------------------------------------
# AC: auth rejection → EXIT_UNEXPECTED (not EXIT_CONFIG)
# ---------------------------------------------------------------------------


class _AuthRejectingSMTP(FakeSMTP):
    def login(self, user, password):
        raise smtplib.SMTPAuthenticationError(535, b"Authentication failed")


def test_auth_rejection_returns_exit_unexpected(monkeypatch, tmp_path):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, _digest())
    monkeypatch.setattr(smtplib, "SMTP", _AuthRejectingSMTP)

    rc = _run(monkeypatch)

    assert rc == EXIT_UNEXPECTED


# ---------------------------------------------------------------------------
# AC: DB opened read-only — writes raise OperationalError
# ---------------------------------------------------------------------------


def test_db_opened_read_only(tmp_path):
    """A write through connect_db_ro raises sqlite3.OperationalError (NFR-1)."""
    from app.cli_common import connect_db_ro

    # Create a real DB file with the schema
    db_path = tmp_path / "kin.sqlite"
    conn_rw = connect(db_path)
    conn_rw.close()

    conn_ro = connect_db_ro(db_path, expected_schema_version=db.SCHEMA_VERSION)
    try:
        with pytest.raises(sqlite3.OperationalError):
            conn_ro.execute(
                "INSERT INTO digests (user_id, generated_at, window_hours, "
                "window_start, window_end, model, prompt_version, include_other, "
                "args, classified_count, actionable_count, informational_count, "
                "skipped_other_count, dropped_low_count, markdown, json_payload) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("jerome", "2026-01-01T00:00:00", 24, "2026-01-01T00:00:00",
                 "2026-01-01T00:00:00", "m", "v", 0, "{}", 0, 0, 0, 0, 0, "#", "{}"),
            )
    finally:
        conn_ro.close()


def test_send_uses_connect_db_ro_not_db_connect(monkeypatch, tmp_path, capsys):
    """main() must use connect_db_ro, never db.connect."""
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, _digest())
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)

    connect_called = []

    original_connect = db.connect

    def _spy_connect(*args, **kwargs):
        connect_called.append(args)
        return original_connect(*args, **kwargs)

    monkeypatch.setattr(db, "connect", _spy_connect)

    _run(monkeypatch)
    capsys.readouterr()

    assert connect_called == [], "db.connect must not be called from app.send.main()"


# ---------------------------------------------------------------------------
# AC: transport — happy path, call order, defaults
# ---------------------------------------------------------------------------


def test_happy_path_smtp_call_order_and_defaults(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, _digest())
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)

    rc = _run(monkeypatch)
    capsys.readouterr()

    assert rc == EXIT_OK
    assert len(FakeSMTP.instances) == 1
    inst = FakeSMTP.instances[0]

    # Default host/port
    assert inst.host == "smtp.gmail.com"
    assert inst.port == 587

    # Call order: starttls → login → send_message
    assert inst.calls == ["starttls", "login:sender@gmail.com", "send_message"]


# ---------------------------------------------------------------------------
# AC: SMTP_HOST / SMTP_PORT overrides
# ---------------------------------------------------------------------------


def test_smtp_host_port_overrides(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, _digest())
    monkeypatch.setenv("SMTP_HOST", "mail.example.com")
    monkeypatch.setenv("SMTP_PORT", "465")
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)

    rc = _run(monkeypatch)
    capsys.readouterr()

    assert rc == EXIT_OK
    assert len(FakeSMTP.instances) == 1
    inst = FakeSMTP.instances[0]
    assert inst.host == "mail.example.com"
    assert inst.port == 465  # coerced to int


# ---------------------------------------------------------------------------
# AC: recipient resolution
# ---------------------------------------------------------------------------


def test_resolve_recipient_prefers_kin_digest_to(monkeypatch):
    monkeypatch.setenv("KIN_DIGEST_TO", "digest@example.com")
    monkeypatch.setenv("GMAIL_ADDRESS", "gmail@example.com")
    assert send_mod.resolve_recipient() == "digest@example.com"


def test_resolve_recipient_falls_back_to_gmail_address(monkeypatch):
    monkeypatch.delenv("KIN_DIGEST_TO", raising=False)
    monkeypatch.setenv("GMAIL_ADDRESS", "gmail@example.com")
    assert send_mod.resolve_recipient() == "gmail@example.com"


def test_to_header_matches_resolved_recipient(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, _digest())
    monkeypatch.setenv("KIN_DIGEST_TO", "custom-recipient@example.com")
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)

    rc = _run(monkeypatch)
    capsys.readouterr()

    assert rc == EXIT_OK
    inst = FakeSMTP.instances[0]
    assert inst._sent_msg["To"] == "custom-recipient@example.com"


# ---------------------------------------------------------------------------
# AC: build_message structure
# ---------------------------------------------------------------------------


def test_build_message_structure(monkeypatch):
    from app.send import build_message

    monkeypatch.delenv("KIN_DIGEST_TO", raising=False)
    digest = _digest()
    msg = build_message(digest, sender="from@example.com", recipient="to@example.com")

    assert msg["From"] == "from@example.com"
    assert msg["To"] == "to@example.com"
    assert "Subject" in msg
    assert "kin daily digest" in msg["Subject"]

    # Must be multipart/alternative
    assert msg.get_content_type() == "multipart/alternative"

    parts = list(msg.iter_parts())
    assert len(parts) >= 2

    # text/plain must come before text/html
    content_types = [p.get_content_type() for p in parts]
    plain_idx = content_types.index("text/plain")
    html_idx = content_types.index("text/html")
    assert plain_idx < html_idx


# ---------------------------------------------------------------------------
# AC: --digest-id scoping
# ---------------------------------------------------------------------------


def test_digest_id_owned_by_user_sends(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    conn = connect(db_path)
    try:
        digest_id = seed_digest(
            conn,
            user_id="jerome",
            json_payload=_digest(user_id="jerome").to_json(),
            actionable_count=1,
            classified_count=1,
        )
    finally:
        conn.close()

    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)

    rc = _run(monkeypatch, "--digest-id", str(digest_id))
    capsys.readouterr()

    assert rc == EXIT_OK


def test_digest_id_owned_by_different_user_exits_config(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    conn = connect(db_path)
    try:
        digest_id = seed_digest(
            conn,
            user_id="alice",
            json_payload=_digest(user_id="alice").to_json(),
            actionable_count=1,
            classified_count=1,
        )
    finally:
        conn.close()

    monkeypatch.setattr(smtplib, "SMTP", _NeverInstantiate)

    rc = _run(monkeypatch, "--user", "jerome", "--digest-id", str(digest_id))
    capsys.readouterr()

    assert rc == EXIT_CONFIG


def test_digest_id_nonexistent_exits_config(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, _digest())
    monkeypatch.setattr(smtplib, "SMTP", _NeverInstantiate)

    rc = _run(monkeypatch, "--digest-id", "9999")
    capsys.readouterr()

    assert rc == EXIT_CONFIG


# ---------------------------------------------------------------------------
# AC: --user scopes the latest-digest fetch
# ---------------------------------------------------------------------------


def test_user_scopes_latest_fetch(monkeypatch, tmp_path, capsys):
    """--user alice finds alice's digest, not jerome's."""
    db_path = _setup_env(monkeypatch, tmp_path)
    conn = connect(db_path)
    try:
        seed_digest(
            conn,
            user_id="jerome",
            json_payload=_digest(user_id="jerome").to_json(),
            actionable_count=1,
            classified_count=1,
        )
        seed_digest(
            conn,
            user_id="alice",
            json_payload=_digest(user_id="alice").to_json(),
            actionable_count=1,
            classified_count=1,
        )
    finally:
        conn.close()

    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)

    # jerome's scope
    rc = _run(monkeypatch, "--user", "jerome")
    capsys.readouterr()
    assert rc == EXIT_OK

    FakeSMTP.instances.clear()

    # alice's scope
    rc = _run(monkeypatch, "--user", "alice")
    capsys.readouterr()
    assert rc == EXIT_OK


def test_no_digest_for_user_exits_config(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    # DB is empty (but valid schema)
    conn = connect(db_path)
    conn.close()

    monkeypatch.setattr(smtplib, "SMTP", _NeverInstantiate)

    rc = _run(monkeypatch, "--user", "nobody")
    capsys.readouterr()

    assert rc == EXIT_CONFIG


# ---------------------------------------------------------------------------
# AC: empty digest still produces a message
# ---------------------------------------------------------------------------


def test_empty_digest_dry_run_produces_message(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, _digest(items=[], actionable_count=0, classified_count=0))
    monkeypatch.setattr(smtplib, "SMTP", _NeverInstantiate)

    rc = _run(monkeypatch, "--dry-run")

    assert rc == EXIT_OK
    out = capsys.readouterr().out
    # Must have a Subject header and both parts
    assert "Subject:" in out
    assert "text/plain" in out
    assert "text/html" in out


def test_empty_digest_sends(monkeypatch, tmp_path, capsys):
    db_path = _setup_env(monkeypatch, tmp_path)
    _seed_db(db_path, _digest(items=[], actionable_count=0, classified_count=0))
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)

    rc = _run(monkeypatch)
    capsys.readouterr()

    assert rc == EXIT_OK
    assert len(FakeSMTP.instances) == 1
    assert "send_message" in FakeSMTP.instances[0].calls

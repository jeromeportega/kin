"""Integration tests for ingest.run — real SQLite DB, fake EmailSource.

Tests exercise the real app.email_filters → app.classify_email →
app.db leaf functions (only classify is mocked, never app.db) to prove:
  - per-user rows land with user_id = user_email
  - dedup via UNIQUE(user_id, message_id) + upsert_email ON CONFLICT
  - digest is built and persisted after each run
"""
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from typing import Iterator
from unittest.mock import patch

import pytest

from app import db
from app.email_source import FetchedEmail
from app.schemas.email import Category, EmailClassification, Priority
from ingest.run import EXIT_CONFIG, EXIT_DB, EXIT_OK, EXIT_REAUTH, IngestionResult, run_ingestion


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

FAKE_CLASSIFICATION = EmailClassification(
    category=Category.personal,
    priority=Priority.medium,
    action_required=True,
    summary="Test email summary",
    action_items=["Reply to this email"],
    dates=[],
    confidence=0.9,
)


class FakeSource:
    """Minimal EmailSource that yields a fixed list of FetchedEmail objects."""

    def __init__(self, emails: list[FetchedEmail]) -> None:
        self._emails = emails

    def fetch_recent(self, hours: int, limit: int) -> Iterator[FetchedEmail]:
        yield from self._emails


def _email(
    *,
    message_id: str = "<msg1@example.com>",
    uid: str = "uid1",
    from_addr: str = "allowed@example.com",
    subject: str = "Test Subject",
    hours_ago: float = 1.0,
) -> FetchedEmail:
    return FetchedEmail(
        uid=uid,
        message_id=message_id,
        from_addr=from_addr,
        to_addrs=("me@x.com",),
        cc_addrs=(),
        subject=subject,
        date=datetime.now(timezone.utc) - timedelta(hours=hours_ago),
        text_body="Test email body text",
        truncated=False,
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def config_path(tmp_path):
    """Minimal kin.toml that allowlists the test sender address."""
    p = tmp_path / "kin.toml"
    p.write_text(
        "[filters]\n"
        'sender_allowlist = ["allowed@example.com"]\n'
    )
    return p


@pytest.fixture
def db_path(tmp_path):
    return tmp_path / "kin.sqlite"


@pytest.fixture
def token_store_path(tmp_path):
    # Tests always inject source= so this path is never read.
    return tmp_path / "tokens.json"


def _run(
    source: FakeSource,
    *,
    user_email: str = "me@x.com",
    db_path,
    config_path,
    token_store_path,
    hours: int = 24,
) -> IngestionResult:
    return run_ingestion(
        user_email=user_email,
        hours=hours,
        limit=50,
        db_path=db_path,
        config_path=config_path,
        token_store_path=token_store_path,
        source=source,
    )


# ---------------------------------------------------------------------------
# AC1/AC2 — happy path: per-user rows written under the correct user_id
# ---------------------------------------------------------------------------


def test_happy_path_emails_persisted_with_correct_user_id(
    config_path, db_path, token_store_path
):
    e1 = _email(message_id="<msg1@example.com>", uid="uid1")
    e2 = _email(message_id="<msg2@example.com>", uid="uid2")

    with patch("ingest.run.classify", return_value=FAKE_CLASSIFICATION):
        result = _run(
            FakeSource([e1, e2]),
            user_email="me@x.com",
            db_path=db_path,
            config_path=config_path,
            token_store_path=token_store_path,
        )

    assert result.fetched == 2
    assert result.filtered == 2
    assert result.classified == 2
    assert result.errors == 0

    conn = db.connect(db_path)
    try:
        rows = conn.execute("SELECT user_id FROM emails").fetchall()
        assert len(rows) == 2
        assert all(r["user_id"] == "me@x.com" for r in rows)

        cls_rows = conn.execute(
            "SELECT * FROM classifications WHERE error IS NULL"
        ).fetchall()
        assert len(cls_rows) == 2
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# AC4 — digest persisted; IngestionResult.digest_id is not None
# ---------------------------------------------------------------------------


def test_digest_persisted_after_run(config_path, db_path, token_store_path):
    e1 = _email(message_id="<msg1@example.com>", uid="uid1")

    with patch("ingest.run.classify", return_value=FAKE_CLASSIFICATION):
        result = _run(
            FakeSource([e1]),
            user_email="me@x.com",
            db_path=db_path,
            config_path=config_path,
            token_store_path=token_store_path,
        )

    assert result.digest_id is not None

    conn = db.connect(db_path)
    try:
        row = conn.execute(
            "SELECT user_id FROM digests WHERE id = ?", (result.digest_id,)
        ).fetchone()
        assert row is not None
        assert row["user_id"] == "me@x.com"
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# AC3 — dedup: second run with same message IDs does not grow the emails table
# ---------------------------------------------------------------------------


def test_dedup_second_run_does_not_grow_rows(config_path, db_path, token_store_path):
    e1 = _email(message_id="<msg1@example.com>", uid="uid1")
    e2 = _email(message_id="<msg2@example.com>", uid="uid2")

    with patch("ingest.run.classify", return_value=FAKE_CLASSIFICATION):
        result1 = _run(
            FakeSource([e1, e2]),
            user_email="me@x.com",
            db_path=db_path,
            config_path=config_path,
            token_store_path=token_store_path,
        )
        assert result1.classified == 2

        result2 = _run(
            FakeSource([e1, e2]),
            user_email="me@x.com",
            db_path=db_path,
            config_path=config_path,
            token_store_path=token_store_path,
        )

    conn = db.connect(db_path)
    try:
        count = conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0]
        assert count == 2  # no new rows

        assert result2.reused == 2   # both hit the classification cache
        assert result2.classified == 0
    finally:
        conn.close()


def test_dedup_last_seen_at_is_bumped_on_second_run(
    config_path, db_path, token_store_path
):
    e1 = _email(message_id="<msg1@example.com>", uid="uid1")

    t0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    t1 = t0 + timedelta(seconds=1)

    with patch("ingest.run.classify", return_value=FAKE_CLASSIFICATION):
        with patch("ingest.run._utcnow", return_value=t0):
            _run(
                FakeSource([e1]),
                user_email="me@x.com",
                db_path=db_path,
                config_path=config_path,
                token_store_path=token_store_path,
            )

        with patch("ingest.run._utcnow", return_value=t1):
            _run(
                FakeSource([e1]),
                user_email="me@x.com",
                db_path=db_path,
                config_path=config_path,
                token_store_path=token_store_path,
            )

    conn = db.connect(db_path)
    try:
        row = conn.execute(
            "SELECT first_seen_at, last_seen_at FROM emails WHERE message_id = ?",
            ("<msg1@example.com>",),
        ).fetchone()
        assert row["first_seen_at"] < row["last_seen_at"]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Pre-filter branch: email rejected by should_classify → not classified
# ---------------------------------------------------------------------------


def test_prefilter_rejected_email_not_classified(config_path, db_path, token_store_path):
    allowed = _email(message_id="<allowed@example.com>", uid="uid1",
                     from_addr="allowed@example.com")
    blocked = _email(message_id="<blocked@example.com>", uid="uid2",
                     from_addr="blocked@nolist.example.com")

    with patch("ingest.run.classify", return_value=FAKE_CLASSIFICATION) as mock_classify:
        result = _run(
            FakeSource([allowed, blocked]),
            user_email="me@x.com",
            db_path=db_path,
            config_path=config_path,
            token_store_path=token_store_path,
        )

    assert result.fetched == 2
    assert result.filtered == 1   # only the allowlisted email survived
    assert result.classified == 1
    assert mock_classify.call_count == 1  # classify called only for the survivor

    conn = db.connect(db_path)
    try:
        count = conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0]
        assert count == 1  # only the allowed email was persisted
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Classify cache reuse: second pass hits find_classification; classify not called
# ---------------------------------------------------------------------------


def test_classify_cache_reuse_on_second_run(config_path, db_path, token_store_path):
    e1 = _email(message_id="<msg1@example.com>", uid="uid1")

    with patch("ingest.run.classify", return_value=FAKE_CLASSIFICATION) as mock_classify:
        _run(
            FakeSource([e1]),
            user_email="me@x.com",
            db_path=db_path,
            config_path=config_path,
            token_store_path=token_store_path,
        )
        assert mock_classify.call_count == 1

        _run(
            FakeSource([e1]),
            user_email="me@x.com",
            db_path=db_path,
            config_path=config_path,
            token_store_path=token_store_path,
        )
        # Cached — classify must not have been called a second time.
        assert mock_classify.call_count == 1


# ---------------------------------------------------------------------------
# Empty source: no rows written, no error, fetched == 0
# ---------------------------------------------------------------------------


def test_empty_source_no_rows_written(config_path, db_path, token_store_path):
    result = _run(
        FakeSource([]),
        user_email="me@x.com",
        db_path=db_path,
        config_path=config_path,
        token_store_path=token_store_path,
    )

    assert result.fetched == 0
    assert result.classified == 0
    assert result.errors == 0
    assert result.digest_id is not None  # digest persisted even for an empty run

    conn = db.connect(db_path)
    try:
        count = conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0]
        assert count == 0
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Read/write seam: DB opened via app.db.connect() — write succeeds
# ---------------------------------------------------------------------------


def test_db_opened_read_write_writes_succeed(config_path, db_path, token_store_path):
    """Verify writes land; if the DB were read-only, upsert_email would raise."""
    e1 = _email(message_id="<msg1@example.com>", uid="uid1")

    with patch("ingest.run.classify", return_value=FAKE_CLASSIFICATION):
        result = _run(
            FakeSource([e1]),
            user_email="me@x.com",
            db_path=db_path,
            config_path=config_path,
            token_store_path=token_store_path,
        )

    conn = db.connect(db_path)
    try:
        count = conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0]
        assert count == 1
    finally:
        conn.close()

    assert result.errors == 0


# ---------------------------------------------------------------------------
# main() exit codes — EXIT_REAUTH, EXIT_CONFIG, EXIT_DB
# ---------------------------------------------------------------------------


def test_main_exit_reauth(config_path, db_path, token_store_path):
    """A source that raises ReauthRequired maps to EXIT_REAUTH (2)."""
    from ingest.oauth import ReauthRequired
    from ingest.run import main

    class ReauthSource:
        def fetch_recent(self, hours, limit):
            raise ReauthRequired("token expired")

    with patch("ingest.run.run_ingestion", side_effect=ReauthRequired("expired")):
        with patch("sys.argv", ["ingest.run", "--user", "me@x.com",
                                "--config", str(config_path),
                                "--db", str(db_path),
                                "--token-store", str(token_store_path)]):
            assert main() == EXIT_REAUTH


def test_main_exit_config_missing_token(config_path, db_path, tmp_path):
    """Missing token file maps to EXIT_CONFIG (3)."""
    from ingest.run import main

    missing_tokens = tmp_path / "no_tokens.json"

    with patch("sys.argv", ["ingest.run", "--user", "me@x.com",
                            "--config", str(config_path),
                            "--db", str(db_path),
                            "--token-store", str(missing_tokens)]):
        with patch("ingest.run.run_ingestion",
                   side_effect=FileNotFoundError("no token")):
            assert main() == EXIT_CONFIG


def test_main_exit_db(config_path, db_path, token_store_path):
    """A sqlite3.DatabaseError maps to EXIT_DB (4)."""
    from ingest.run import main

    with patch("ingest.run.run_ingestion",
               side_effect=sqlite3.DatabaseError("disk full")):
        with patch("sys.argv", ["ingest.run", "--user", "me@x.com",
                                "--config", str(config_path),
                                "--db", str(db_path),
                                "--token-store", str(token_store_path)]):
            assert main() == EXIT_DB


def test_main_exit_ok(config_path, db_path, token_store_path):
    """Successful run returns EXIT_OK (0)."""
    from ingest.run import main

    fake_result = IngestionResult(
        fetched=1, filtered=1, classified=1, reused=0, errors=0, digest_id=42
    )
    with patch("ingest.run.run_ingestion", return_value=fake_result):
        with patch("sys.argv", ["ingest.run", "--user", "me@x.com",
                                "--config", str(config_path),
                                "--db", str(db_path),
                                "--token-store", str(token_store_path)]):
            assert main() == EXIT_OK

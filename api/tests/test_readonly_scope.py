"""Guarantee tests: read-only enforcement (T1/NFR-1) and user-scope isolation (T3/NFR-2).

T1/NFR-1: The API's SQLite connection is opened with URI mode=ro; any write raises
           sqlite3.OperationalError from SQLite itself, not from application code.
T3/NFR-2: Each endpoint returns only rows for the requested user_id; neither the
           $KIN_USER default nor an explicit ?user_id= param leaks another user's rows.
ADR-005:  The ?user_id= param is trusted and unbound to authenticated identity.
           The isolation test asserts query scoping works, not that cross-user
           requests are prevented at the API layer (that hardening lives elsewhere).
"""
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import app.db as db
from api.deps import get_ro_conn
from app.digest import Digest


# ---------------------------------------------------------------------------
# Local seeding helpers (digest via api/conftest.seed_users; classifications
# and runs added here to cover all three endpoints in scope-isolation tests)
# ---------------------------------------------------------------------------

def _make_digest_json(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    d = Digest(
        generated_at=now.isoformat(),
        user_id=user_id,
        model="test-model",
        prompt_version="v1",
        window_hours=24,
        window_start=(now - timedelta(hours=24)).isoformat(),
        window_end=now.isoformat(),
        include_other=False,
        classified_count=0,
        actionable_count=0,
        informational_count=0,
        skipped_other_count=0,
        dropped_low_count=0,
        items=[],
    )
    return d.to_json()


def _seed_digest(db_path: Path, user_id: str) -> None:
    """Insert a valid digest row for user_id."""
    conn = db.connect(str(db_path))
    now = datetime.now(timezone.utc)
    with conn:
        conn.execute(
            """INSERT INTO digests (user_id, generated_at, window_hours,
                   window_start, window_end, model, prompt_version, include_other,
                   args, classified_count, actionable_count, informational_count,
                   skipped_other_count, dropped_low_count, markdown, json_payload)
               VALUES (?, ?, 24, ?, ?, 'test-model', 'v1', 0, '{}',
                       0, 0, 0, 0, 0, '', ?)""",
            (
                user_id,
                now.isoformat(),
                (now - timedelta(hours=24)).isoformat(),
                now.isoformat(),
                _make_digest_json(user_id),
            ),
        )
    conn.close()


def _seed_email_and_classification(db_path: Path, user_id: str) -> tuple[int, int]:
    """Insert one email + classification for user_id.

    message_id is scoped to user_id so tests can assert which user's row
    appeared in the response.
    """
    conn = db.connect(str(db_path))
    now = datetime.now(timezone.utc)
    email_date = (now - timedelta(hours=1)).isoformat()
    iso = now.isoformat()
    with conn:
        cur = conn.execute(
            """INSERT INTO emails (user_id, folder, message_id, uid, from_addr,
                   subject, date, text_body, truncated, first_seen_at, last_seen_at)
               VALUES (?, 'INBOX', ?, NULL, 'from@example.com', 'Subject',
                       ?, 'body', 0, ?, ?)""",
            (user_id, f"<{user_id}@scope-test>", email_date, iso, iso),
        )
        email_id = cur.lastrowid
        cur = conn.execute(
            """INSERT INTO classifications (email_id, model, prompt_version,
                   category, priority, action_required, summary, action_items,
                   dates, confidence, truncated, error, classified_at)
               VALUES (?, 'test-model', 'v1', 'action', 'high', 1,
                       'Summary', '[]', '[]', 0.9, 0, NULL, ?)""",
            (email_id, iso),
        )
        class_id = cur.lastrowid
    conn.close()
    return email_id, class_id


def _seed_run(db_path: Path, user_id: str) -> int:
    """Insert one run row for user_id, return its id."""
    conn = db.connect(str(db_path))
    now = datetime.now(timezone.utc).isoformat()
    with conn:
        cur = conn.execute(
            """INSERT INTO runs (user_id, started_at, model, prompt_version, args,
                   fetched, filtered, classified, reused, errors, truncated)
               VALUES (?, ?, 'test-model', 'v1', '{}', 1, 0, 1, 0, 0, 0)""",
            (user_id, now),
        )
    conn.close()
    return cur.lastrowid


# ---------------------------------------------------------------------------
# T1/NFR-1: Read-only enforcement at the SQLite layer
# ---------------------------------------------------------------------------

class TestReadOnlyEnforcement:
    """The connection yielded by get_ro_conn must reject all writes at the VFS level.

    SQLite opens the file with mode=ro in the URI, which causes the engine itself
    to raise OperationalError("attempt to write a readonly database") on any
    mutation. Application code never runs a check of its own, so the error
    message is a reliable proxy for 'this came from SQLite, not from us'.
    """

    def _borrow_conn(self, db_path: Path):
        """Advance get_ro_conn's generator to obtain the live connection and generator."""
        gen = get_ro_conn(db_path)
        conn = next(gen)
        return conn, gen

    def _return_conn(self, gen) -> None:
        try:
            next(gen)
        except StopIteration:
            pass

    def test_insert_raises_operational_error(self, seeded_db_path):
        """INSERT through the API's read-only connection must raise sqlite3.OperationalError."""
        conn, gen = self._borrow_conn(seeded_db_path)
        try:
            with pytest.raises(sqlite3.OperationalError) as exc_info:
                conn.execute(
                    "INSERT INTO _meta (key, value) VALUES ('probe', 'probe')"
                )
            assert "readonly" in str(exc_info.value).lower()
        finally:
            self._return_conn(gen)

    def test_update_raises_operational_error(self, seeded_db_path):
        """UPDATE through the API's read-only connection must raise sqlite3.OperationalError."""
        conn, gen = self._borrow_conn(seeded_db_path)
        try:
            with pytest.raises(sqlite3.OperationalError) as exc_info:
                conn.execute(
                    "UPDATE _meta SET value = 'tampered' WHERE key = 'schema_version'"
                )
            assert "readonly" in str(exc_info.value).lower()
        finally:
            self._return_conn(gen)

    def test_error_originates_from_sqlite_not_application_code(self, seeded_db_path):
        """The OperationalError message is SQLite's own 'attempt to write a readonly database'.

        This distinguishes a real VFS-layer restriction from an application-level
        guard: app checks would raise a different exception or message, not SQLite's
        internal readonly error.
        """
        conn, gen = self._borrow_conn(seeded_db_path)
        try:
            with pytest.raises(sqlite3.OperationalError) as exc_info:
                conn.execute("DELETE FROM _meta WHERE key = 'schema_version'")
            assert "attempt to write a readonly database" in str(exc_info.value).lower()
        finally:
            self._return_conn(gen)


# ---------------------------------------------------------------------------
# T3/NFR-2: Scope isolation — no cross-user row leakage per endpoint
# ---------------------------------------------------------------------------

USER_A = "alice"
USER_B = "bob"


@pytest.fixture
def two_user_db(seeded_db_path) -> Path:
    """Seed one digest, one classification, and one run for both USER_A and USER_B."""
    for user in (USER_A, USER_B):
        _seed_digest(seeded_db_path, user)
        _seed_email_and_classification(seeded_db_path, user)
        _seed_run(seeded_db_path, user)
    return seeded_db_path


class TestScopeIsolation:
    """Each endpoint returns only rows belonging to the requested user_id."""

    def test_digest_latest_returns_only_requested_user(self, client, two_user_db):
        resp_a = client.get(f"/api/digest/latest?user_id={USER_A}")
        assert resp_a.status_code == 200
        assert resp_a.json()["user_id"] == USER_A

        resp_b = client.get(f"/api/digest/latest?user_id={USER_B}")
        assert resp_b.status_code == 200
        assert resp_b.json()["user_id"] == USER_B

        # Cross-check: neither response contains the other user's id
        assert resp_a.json()["user_id"] != USER_B
        assert resp_b.json()["user_id"] != USER_A

    def test_classifications_returns_only_requested_user(self, client, two_user_db):
        resp_a = client.get(f"/api/classifications?user_id={USER_A}&hours=24")
        assert resp_a.status_code == 200
        data_a = resp_a.json()
        assert len(data_a) == 1
        # message_id was seeded as <alice@scope-test> / <bob@scope-test>
        assert data_a[0]["message_id"] == f"<{USER_A}@scope-test>"

        resp_b = client.get(f"/api/classifications?user_id={USER_B}&hours=24")
        assert resp_b.status_code == 200
        data_b = resp_b.json()
        assert len(data_b) == 1
        assert data_b[0]["message_id"] == f"<{USER_B}@scope-test>"

        # Cross-check: USER_B's message_id never appears in USER_A's results
        a_ids = {row["message_id"] for row in data_a}
        b_ids = {row["message_id"] for row in data_b}
        assert not a_ids & b_ids, "classifications leaked between users"

    def test_runs_returns_only_requested_user(self, client, two_user_db):
        resp_a = client.get(f"/api/runs?user_id={USER_A}")
        assert resp_a.status_code == 200
        data_a = resp_a.json()
        assert len(data_a) == 1
        assert all(row["user_id"] == USER_A for row in data_a)

        resp_b = client.get(f"/api/runs?user_id={USER_B}")
        assert resp_b.status_code == 200
        data_b = resp_b.json()
        assert len(data_b) == 1
        assert all(row["user_id"] == USER_B for row in data_b)

        # Cross-check: no USER_B ids appear in USER_A's results
        a_ids = {row["id"] for row in data_a}
        b_ids = {row["id"] for row in data_b}
        assert not a_ids & b_ids, "run ids leaked between users"


# ---------------------------------------------------------------------------
# Both scope resolution paths: $KIN_USER default and explicit ?user_id= param
# ---------------------------------------------------------------------------

class TestScopeResolutionPaths:
    """Both the $KIN_USER env default and an explicit ?user_id= param select correct rows."""

    def test_kin_user_env_default_scopes_runs_to_correct_user(
        self, seeded_db_path, client, monkeypatch
    ):
        """No ?user_id= param → $KIN_USER env var determines the scope."""
        monkeypatch.delenv("KIN_DEMO_USER", raising=False)
        monkeypatch.setenv("KIN_USER", USER_A)
        _seed_run(seeded_db_path, USER_A)
        _seed_run(seeded_db_path, USER_B)

        resp = client.get("/api/runs")  # no user_id param
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["user_id"] == USER_A

    def test_explicit_user_id_param_scopes_runs_to_correct_user(
        self, seeded_db_path, client, monkeypatch
    ):
        """Explicit ?user_id= param returns that user's rows."""
        monkeypatch.delenv("KIN_DEMO_USER", raising=False)
        monkeypatch.delenv("KIN_USER", raising=False)
        _seed_run(seeded_db_path, USER_A)
        _seed_run(seeded_db_path, USER_B)

        resp = client.get(f"/api/runs?user_id={USER_B}")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["user_id"] == USER_B


# ---------------------------------------------------------------------------
# ADR-005: Accepted-risk documentation
# The ?user_id= param is trusted and unbound to identity; a caller may request
# another user's data and the API will honor it. This is the accepted risk.
# Hardening (tying user_id to an authenticated session) belongs to resolve_user_id
# or an auth middleware layer, not to the query-scoping logic.
# ---------------------------------------------------------------------------

class TestAcceptedRiskUserIdTrusted:
    """ADR-005: ?user_id= is trusted; query scoping works but cross-user access is not blocked."""

    def test_explicit_user_id_b_honored_when_default_is_a(
        self, seeded_db_path, client, monkeypatch
    ):
        """?user_id=bob IS honored when $KIN_USER=alice, returning bob's rows.

        This test documents accepted risk: query scoping correctly isolates rows,
        but the API does not prevent an authenticated-alice from requesting bob's
        data. That boundary enforcement belongs to an auth layer (ADR-005).
        """
        monkeypatch.delenv("KIN_DEMO_USER", raising=False)
        monkeypatch.setenv("KIN_USER", USER_A)
        _seed_run(seeded_db_path, USER_A)
        _seed_run(seeded_db_path, USER_B)

        resp = client.get(f"/api/runs?user_id={USER_B}")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1, "expected exactly USER_B's run"
        assert data[0]["user_id"] == USER_B, (
            "ADR-005: ?user_id= is trusted/unbound; bob's rows are returned even "
            "though $KIN_USER defaults to alice — this is the accepted risk"
        )

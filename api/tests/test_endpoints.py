"""Integration tests for GET /api/digest/latest, /api/classifications, /api/runs.

Uses the TestClient from api/conftest.py with a temp seeded DB (dependency override).
"""
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import app.db as db
from app.digest import Digest


# ---------------------------------------------------------------------------
# Seeding helpers (local to this file — not added to conftest.py per story rules)
# ---------------------------------------------------------------------------

def _make_digest_json(user_id: str, window_hours: int = 24) -> str:
    now = datetime.now(timezone.utc)
    d = Digest(
        generated_at=now.isoformat(),
        user_id=user_id,
        model="test-model",
        prompt_version="v1",
        window_hours=window_hours,
        window_start=(now - timedelta(hours=window_hours)).isoformat(),
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


def _seed_digest(db_path: Path, user_id: str, window_hours: int = 24) -> None:
    conn = db.connect(str(db_path))
    now = datetime.now(timezone.utc)
    json_payload = _make_digest_json(user_id, window_hours)
    with conn:
        conn.execute(
            """INSERT INTO digests (user_id, generated_at, window_hours,
                   window_start, window_end, model, prompt_version, include_other,
                   args, classified_count, actionable_count, informational_count,
                   skipped_other_count, dropped_low_count, markdown, json_payload)
               VALUES (?, ?, ?, ?, ?, 'test-model', 'v1', 0, '{}',
                       0, 0, 0, 0, 0, '', ?)""",
            (
                user_id,
                now.isoformat(),
                window_hours,
                (now - timedelta(hours=window_hours)).isoformat(),
                now.isoformat(),
                json_payload,
            ),
        )
    conn.close()


def _seed_email_and_classification(
    db_path: Path,
    user_id: str,
    email_date: str,
    message_id: str = "<test@example.com>",
) -> tuple[int, int]:
    conn = db.connect(str(db_path))
    now = datetime.now(timezone.utc).isoformat()
    with conn:
        cur = conn.execute(
            """INSERT INTO emails (user_id, folder, message_id, uid, from_addr,
                   subject, date, text_body, truncated, first_seen_at, last_seen_at)
               VALUES (?, 'INBOX', ?, NULL, 'from@example.com', 'Subject',
                       ?, 'body', 0, ?, ?)""",
            (user_id, message_id, email_date, now, now),
        )
        email_id = cur.lastrowid
        cur = conn.execute(
            """INSERT INTO classifications (email_id, model, prompt_version,
                   category, priority, action_required, summary, action_items,
                   dates, confidence, truncated, error, classified_at)
               VALUES (?, 'test-model', 'v1', 'action', 'high', 1,
                       'Summary', '[]', '[]', 0.9, 0, NULL, ?)""",
            (email_id, now),
        )
        class_id = cur.lastrowid
    conn.close()
    return email_id, class_id


def _seed_run(db_path: Path, user_id: str, started_at: str) -> int:
    conn = db.connect(str(db_path))
    with conn:
        cur = conn.execute(
            """INSERT INTO runs (user_id, started_at, model, prompt_version, args,
                   fetched, filtered, classified, reused, errors, truncated)
               VALUES (?, ?, 'test-model', 'v1', '{}', 1, 0, 1, 0, 0, 0)""",
            (user_id, started_at),
        )
        run_id = cur.lastrowid
    conn.close()
    return run_id


# ---------------------------------------------------------------------------
# GET /api/digest/latest
# ---------------------------------------------------------------------------

class TestDigestLatest:
    def test_empty_state_returns_204(self, client):
        """Missing digest → 204, never 500 (FR-14)."""
        resp = client.get("/api/digest/latest?user_id=nobody")
        assert resp.status_code == 204

    def test_happy_path_returns_digest_model(self, client, seeded_db_path):
        _seed_digest(seeded_db_path, "jerome", window_hours=24)
        resp = client.get("/api/digest/latest?user_id=jerome&hours=24")
        assert resp.status_code == 200
        data = resp.json()
        assert data["user_id"] == "jerome"
        assert data["window_hours"] == 24
        assert "items" in data
        assert isinstance(data["items"], list)

    def test_happy_path_rehydrated_via_from_json(self, client, seeded_db_path):
        """Digest is rehydrated through fetch_latest_digest_json + Digest.from_json (ADR-002)."""
        _seed_digest(seeded_db_path, "jerome", window_hours=24)
        resp = client.get("/api/digest/latest?user_id=jerome&hours=24")
        assert resp.status_code == 200
        data = resp.json()
        # All DigestModel top-level fields must be present
        for field in ("generated_at", "user_id", "model", "prompt_version",
                      "window_hours", "window_start", "window_end", "include_other",
                      "classified_count", "actionable_count", "informational_count",
                      "skipped_other_count", "dropped_low_count", "items"):
            assert field in data, f"missing field: {field}"

    def test_hours_param_flows_into_window_hours(self, client, seeded_db_path):
        """hours query param is passed as window_hours to fetch_latest_digest_json."""
        _seed_digest(seeded_db_path, "jerome", window_hours=48)
        # fetch_latest_digest_json filters by exact window_hours column equality (WHERE window_hours = ?),
        # so hours=24 must NOT match a row seeded with window_hours=48.
        resp = client.get("/api/digest/latest?user_id=jerome&hours=24")
        assert resp.status_code == 204
        # hours=48 MUST find it
        resp = client.get("/api/digest/latest?user_id=jerome&hours=48")
        assert resp.status_code == 200
        assert resp.json()["window_hours"] == 48

    def test_scope_default_resolves_to_jerome(self, client, seeded_db_path, monkeypatch):
        """No user_id param → resolves to KIN_USER or 'jerome' default."""
        monkeypatch.delenv("KIN_DEMO_USER", raising=False)
        monkeypatch.delenv("KIN_USER", raising=False)
        _seed_digest(seeded_db_path, "jerome", window_hours=24)
        resp = client.get("/api/digest/latest")
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# GET /api/classifications
# ---------------------------------------------------------------------------

class TestClassifications:
    def test_happy_path_returns_classifications(self, client, seeded_db_path):
        now = datetime.now(timezone.utc)
        email_date = (now - timedelta(hours=1)).isoformat()
        _seed_email_and_classification(seeded_db_path, "jerome", email_date)
        resp = client.get("/api/classifications?user_id=jerome&hours=24")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["category"] == "action"
        assert data[0]["priority"] == "high"
        assert data[0]["from_addr"] == "from@example.com"

    def test_happy_path_classification_model_fields(self, client, seeded_db_path):
        now = datetime.now(timezone.utc)
        email_date = (now - timedelta(hours=1)).isoformat()
        _seed_email_and_classification(seeded_db_path, "jerome", email_date)
        resp = client.get("/api/classifications?user_id=jerome&hours=24")
        assert resp.status_code == 200
        row = resp.json()[0]
        for field in ("classification_id", "model", "prompt_version", "category",
                      "priority", "action_required", "summary", "action_items",
                      "dates", "confidence", "classified_at", "email_id",
                      "message_id", "uid", "folder", "from_addr", "subject", "email_date"):
            assert field in row, f"missing field: {field}"

    def test_boundary_zero_hours_returns_empty(self, client, seeded_db_path):
        """hours=0 → window_start==window_end → no emails in window."""
        now = datetime.now(timezone.utc)
        email_date = (now - timedelta(hours=1)).isoformat()
        _seed_email_and_classification(seeded_db_path, "jerome", email_date)
        resp = client.get("/api/classifications?user_id=jerome&hours=0")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_empty_when_no_data(self, client):
        resp = client.get("/api/classifications?user_id=nobody&hours=24")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_scope_default_resolves_to_jerome(self, client, seeded_db_path, monkeypatch):
        monkeypatch.delenv("KIN_DEMO_USER", raising=False)
        monkeypatch.delenv("KIN_USER", raising=False)
        now = datetime.now(timezone.utc)
        _seed_email_and_classification(
            seeded_db_path, "jerome", (now - timedelta(hours=1)).isoformat()
        )
        resp = client.get("/api/classifications?hours=24")
        assert resp.status_code == 200
        assert len(resp.json()) == 1


# ---------------------------------------------------------------------------
# GET /api/runs
# ---------------------------------------------------------------------------

class TestRuns:
    def test_happy_path_returns_runs(self, client, seeded_db_path):
        now = datetime.now(timezone.utc).isoformat()
        _seed_run(seeded_db_path, "jerome", now)
        resp = client.get("/api/runs?user_id=jerome")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["user_id"] == "jerome"
        assert data[0]["model"] == "test-model"

    def test_happy_path_run_model_fields(self, client, seeded_db_path):
        now = datetime.now(timezone.utc).isoformat()
        _seed_run(seeded_db_path, "jerome", now)
        resp = client.get("/api/runs?user_id=jerome")
        assert resp.status_code == 200
        row = resp.json()[0]
        for field in ("id", "user_id", "started_at", "ended_at", "hours", "limit_n",
                      "model", "prompt_version", "fetched", "filtered", "classified",
                      "reused", "errors", "truncated"):
            assert field in row, f"missing field: {field}"
        assert "args" not in row

    def test_newest_first(self, client, seeded_db_path):
        t1 = "2024-01-01T10:00:00+00:00"
        t2 = "2024-01-01T11:00:00+00:00"
        t3 = "2024-01-01T12:00:00+00:00"
        for ts in [t1, t3, t2]:
            _seed_run(seeded_db_path, "jerome", ts)
        resp = client.get("/api/runs?user_id=jerome")
        assert resp.status_code == 200
        data = resp.json()
        assert data[0]["started_at"] == t3
        assert data[1]["started_at"] == t2
        assert data[2]["started_at"] == t1

    def test_limit_param(self, client, seeded_db_path):
        for i in range(5):
            _seed_run(seeded_db_path, "jerome", f"2024-01-0{i+1}T00:00:00+00:00")
        resp = client.get("/api/runs?user_id=jerome&limit=3")
        assert resp.status_code == 200
        assert len(resp.json()) == 3

    def test_empty_when_no_data(self, client):
        resp = client.get("/api/runs?user_id=nobody")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_scope_default_resolves_to_jerome(self, client, seeded_db_path, monkeypatch):
        monkeypatch.delenv("KIN_DEMO_USER", raising=False)
        monkeypatch.delenv("KIN_USER", raising=False)
        _seed_run(seeded_db_path, "jerome", datetime.now(timezone.utc).isoformat())
        resp = client.get("/api/runs")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

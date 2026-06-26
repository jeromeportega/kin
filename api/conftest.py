"""Shared pytest fixtures for the kin API test suite.

These fixtures are imported by test modules across api/tests/. Do not add
new fixtures here from other stories — add local helpers in your own test file
or call seed_users().
"""
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.db
from api.deps import resolve_db_path
from api.main import app as fastapi_app


@pytest.fixture
def seeded_db_path(tmp_path) -> Path:
    """Writable temp kin.sqlite with the full kin schema initialized."""
    db_path = tmp_path / "kin.sqlite"
    conn = app.db.connect(str(db_path))
    conn.close()
    return db_path


@pytest.fixture
def client(seeded_db_path) -> TestClient:
    """FastAPI TestClient with resolve_db_path overridden to seeded_db_path."""
    fastapi_app.dependency_overrides[resolve_db_path] = lambda: seeded_db_path
    with TestClient(fastapi_app) as c:
        yield c
    fastapi_app.dependency_overrides.clear()


def seed_users(db_path: Path, *users: str) -> None:
    """Seed digest + classification + run rows for each user_id."""
    conn = app.db.connect(str(db_path))
    now = datetime.now(timezone.utc).isoformat()
    with conn:
        for user in users:
            conn.execute(
                """INSERT INTO digests (
                    user_id, generated_at, window_hours, window_start, window_end,
                    model, prompt_version, include_other, args,
                    classified_count, actionable_count, informational_count,
                    skipped_other_count, dropped_low_count, markdown, json_payload
                ) VALUES (?, ?, 24, ?, ?, 'test-model', 'v1', 0, '{}',
                    0, 0, 0, 0, 0, '', '{}')""",
                (user, now, now, now),
            )
    conn.close()

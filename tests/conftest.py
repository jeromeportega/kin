"""Pytest fixtures shared across the kin test suite."""
import json
import sqlite3
from datetime import datetime, timezone

import pytest

from app.db import init_schema


@pytest.fixture
def mem_db():
    """A fresh in-memory SQLite DB with the kin schema initialized.

    Foreign keys are enabled; same pragmas as production except for WAL
    journal mode (irrelevant for :memory:).
    """
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    init_schema(conn)
    yield conn
    conn.close()


def seed_digest(
    conn: sqlite3.Connection,
    *,
    user_id: str = "jerome",
    generated_at: datetime | None = None,
    window_hours: int = 24,
    model: str = "qwen3:14b",
    prompt_version: str = "abc",
    include_other: bool = False,
    classified_count: int = 0,
    actionable_count: int = 0,
    informational_count: int = 0,
    skipped_other_count: int = 0,
    dropped_low_count: int = 0,
    markdown: str = "# digest",
    json_payload: str | dict = '{"ok": true}',
) -> int:
    """Insert a row into `digests` without running the full digest CLI.

    Used by tests that want a digest present in the DB to exercise sync /
    query code without going through the full pipeline. The `json_payload`
    can be a JSON string or a dict (auto-serialized).
    """
    if generated_at is None:
        generated_at = datetime.now(timezone.utc)
    iso = generated_at.isoformat()
    if isinstance(json_payload, dict):
        json_payload = json.dumps(json_payload)
    cur = conn.execute(
        """
        INSERT INTO digests (
            user_id, generated_at, window_hours, window_start, window_end,
            model, prompt_version, include_other, args,
            classified_count, actionable_count, informational_count,
            skipped_other_count, dropped_low_count, markdown, json_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            user_id, iso, window_hours, iso, iso,
            model, prompt_version, 1 if include_other else 0, "{}",
            classified_count, actionable_count, informational_count,
            skipped_other_count, dropped_low_count, markdown, json_payload,
        ),
    )
    conn.commit()
    return cur.lastrowid

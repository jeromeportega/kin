"""Pytest fixtures shared across the kin test suite."""
import sqlite3

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

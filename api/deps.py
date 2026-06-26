"""FastAPI dependency seams for the kin API.

Test seam: override `resolve_db_path` via app.dependency_overrides in tests.
"""
import os
import sqlite3
from pathlib import Path
from typing import Annotated, Iterator

from fastapi import Depends

import app.db
from app.cli_common import connect_db_ro

# Named constant so callers and tests import the fallback rather than hardcoding the string.
DEFAULT_KIN_USER = "jerome"


def resolve_db_path() -> Path:
    """$KIN_DB_PATH env var → data/kin.sqlite default.

    When KIN_DB_PATH is set the path is canonicalised (symlinks resolved) and
    validated to end in .sqlite or .db to prevent accidental redirection to
    unrelated files.
    """
    env_path = os.environ.get("KIN_DB_PATH")
    if env_path:
        p = Path(env_path).resolve()
        if p.suffix not in (".sqlite", ".db"):
            raise ValueError(
                f"KIN_DB_PATH must point to a .sqlite or .db file, got: {p}"
            )
        return p
    return Path("data") / "kin.sqlite"


def get_ro_conn(
    db_path: Annotated[Path, Depends(resolve_db_path)],
) -> Iterator[sqlite3.Connection]:
    """Yield a read-only DB connection; close in finally."""
    conn = connect_db_ro(db_path, expected_schema_version=app.db.SCHEMA_VERSION)
    try:
        yield conn
    finally:
        conn.close()


def resolve_user_id(user_id: str | None = None) -> str:
    """Scope precedence (highest → lowest):
    1. explicit ?user_id= query param
    2. $KIN_DEMO_USER env var
    3. $KIN_USER env var
    4. DEFAULT_KIN_USER fallback
    """
    if user_id is not None:
        return user_id
    demo = os.environ.get("KIN_DEMO_USER")
    if demo:
        return demo
    kin_user = os.environ.get("KIN_USER")
    if kin_user:
        return kin_user
    return DEFAULT_KIN_USER

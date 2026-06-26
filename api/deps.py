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


def resolve_db_path() -> Path:
    """$KIN_DB_PATH env var → data/kin.sqlite default."""
    env_path = os.environ.get("KIN_DB_PATH")
    if env_path:
        return Path(env_path)
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
    4. 'jerome' hardcoded fallback
    """
    if user_id is not None:
        return user_id
    demo = os.environ.get("KIN_DEMO_USER")
    if demo:
        return demo
    kin_user = os.environ.get("KIN_USER")
    if kin_user:
        return kin_user
    return "jerome"

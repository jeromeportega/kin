"""GET /api/runs — recent triage runs for a user."""
import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from api.deps import get_ro_conn, resolve_user_id
from api.models import RunModel
from app.db import fetch_runs

router = APIRouter()


@router.get("/runs", response_model=list[RunModel])
def get_runs(
    conn: Annotated[sqlite3.Connection, Depends(get_ro_conn)],
    user_id: Annotated[str, Depends(resolve_user_id)],
    limit: Annotated[int, Query(ge=1, le=500)] = 20,
) -> list[RunModel]:
    """Return the most recent triage runs for the user, newest first."""
    rows = fetch_runs(conn, user_id=user_id, limit=limit)
    return [RunModel(**dict(row)) for row in rows]

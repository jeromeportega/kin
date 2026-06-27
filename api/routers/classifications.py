"""GET /api/classifications — classifications within a rolling time window."""
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from api.deps import get_ro_conn, resolve_user_id
from api.models import ClassificationModel
from app.db import fetch_classifications_window

router = APIRouter()


@router.get("/classifications", response_model=list[ClassificationModel])
def get_classifications(
    conn: Annotated[sqlite3.Connection, Depends(get_ro_conn)],
    user_id: Annotated[str, Depends(resolve_user_id)],
    hours: Annotated[int, Query(ge=0, le=8760)] = 24,
) -> list[ClassificationModel]:
    """Return classifications whose email date falls within the last `hours`."""
    window_end = datetime.now(timezone.utc)
    window_start = window_end - timedelta(hours=hours)
    rows = fetch_classifications_window(
        conn,
        user_id=user_id,
        window_start=window_start,
        window_end=window_end,
    )
    return [ClassificationModel(**dict(row)) for row in rows]

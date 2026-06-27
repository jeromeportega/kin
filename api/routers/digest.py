"""GET /api/digest/latest — latest persisted digest for a user."""
import sqlite3
from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends, Response

from api.deps import get_ro_conn, resolve_user_id
from api.models import DigestModel
from app.db import fetch_latest_digest_json
from app.digest import Digest

router = APIRouter()


@router.get("/digest/latest")
def get_latest_digest(
    conn: Annotated[sqlite3.Connection, Depends(get_ro_conn)],
    user_id: Annotated[str, Depends(resolve_user_id)],
    hours: int = 24,
) -> Response:
    """Return the most recent digest for the user, or 204 if none exists (FR-14)."""
    json_str = fetch_latest_digest_json(conn, user_id=user_id, window_hours=hours)
    if json_str is None:
        return Response(status_code=204)
    return DigestModel.model_validate(asdict(Digest.from_json(json_str)))

"""GET /api/digest/latest — latest persisted digest for a user."""
import logging
import sqlite3
from typing import Annotated, Union

from fastapi import APIRouter, Depends, Query, Response
from pydantic import ValidationError

from api.deps import get_ro_conn, resolve_user_id
from api.models import DigestModel
from app.db import fetch_latest_digest_json

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get(
    "/digest/latest",
    response_model=DigestModel,
    responses={204: {"description": "No digest found"}},
)
def get_latest_digest(
    conn: Annotated[sqlite3.Connection, Depends(get_ro_conn)],
    user_id: Annotated[str, Depends(resolve_user_id)],
    hours: Annotated[int, Query(ge=0, le=8760)] = 24,
) -> Union[Response, DigestModel]:
    """Return the most recent digest for the user, or 204 if none exists (FR-14)."""
    json_str = fetch_latest_digest_json(conn, user_id=user_id, window_hours=hours)
    if json_str is None:
        return Response(status_code=204)
    try:
        return DigestModel.model_validate_json(json_str)
    except ValidationError:
        logger.exception("Stored digest JSON failed Pydantic validation for user=%s", user_id)
        return Response(status_code=204)

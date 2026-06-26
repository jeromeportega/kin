"""kin dashboard API — read-only FastAPI service.

SECURITY: This service is designed for localhost use only. Start uvicorn bound
to 127.0.0.1 (the default). If you must accept connections beyond loopback, set
KIN_API_KEY — every request will then require an ``X-API-Key: <key>`` header.
"""
import importlib
import os
import pkgutil

from fastapi import FastAPI, APIRouter, Request, Response

import app.db as _app_db
import app.digest  # noqa: F401 — prove ADR-004 workspace wiring
import app.cli_common  # noqa: F401
import api.routers as _routers_pkg

app = FastAPI(title="kin dashboard API")

# Read once at startup; restart the service to rotate the key.
_API_KEY: str | None = os.environ.get("KIN_API_KEY")


@app.middleware("http")
async def maybe_require_api_key(request: Request, call_next) -> Response:
    """Enforce KIN_API_KEY shared-secret when configured; no-op otherwise."""
    if _API_KEY and request.headers.get("X-API-Key") != _API_KEY:
        return Response(status_code=401, content="Unauthorized")
    return await call_next(request)


@app.get("/api/health")
def health():
    return {"status": "ok", "schema_version": _app_db.SCHEMA_VERSION, "db": "ro"}


for _info in pkgutil.iter_modules(_routers_pkg.__path__):
    _mod = importlib.import_module(f"api.routers.{_info.name}")
    _router = getattr(_mod, "router", None)
    if isinstance(_router, APIRouter):
        app.include_router(_router, prefix="/api")

"""kin dashboard API — read-only FastAPI service."""
import importlib
import pkgutil

from fastapi import FastAPI

import app.db as _app_db
import app.digest  # noqa: F401 — prove ADR-004 workspace wiring
import app.cli_common  # noqa: F401
import api.routers as _routers_pkg

app = FastAPI(title="kin dashboard API")


@app.get("/api/health")
def health():
    return {"status": "ok", "schema_version": _app_db.SCHEMA_VERSION, "db": "ro"}


for _info in pkgutil.iter_modules(_routers_pkg.__path__):
    _mod = importlib.import_module(f"api.routers.{_info.name}")
    if hasattr(_mod, "router"):
        app.include_router(_mod.router, prefix="/api")

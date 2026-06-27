"""Configuration loader for kin's pre-filter.

Parses a TOML file into a typed `FilterConfig` with normalized lists.
The default path is `kin.toml` (gitignored). See `kin.example.toml` for
the template.
"""
import os
import tomllib
from pathlib import Path
from typing import List

from pydantic import BaseModel, Field, field_validator


class FilterConfig(BaseModel):
    sender_allowlist: List[str] = Field(default_factory=list)
    sender_blocklist: List[str] = Field(default_factory=list)
    subject_keywords: List[str] = Field(default_factory=list)
    body_keywords: List[str] = Field(default_factory=list)

    @field_validator(
        "sender_allowlist",
        "sender_blocklist",
        "subject_keywords",
        "body_keywords",
        mode="after",
    )
    @classmethod
    def _normalize(cls, value: List[str]) -> List[str]:
        return [item.strip().lower() for item in value if item.strip()]


def load_config(path: Path | str = "kin.toml") -> FilterConfig:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(
            f"Config file not found: {path}. "
            f"Copy kin.example.toml to {path} and edit it for your household."
        )
    data = tomllib.loads(path.read_text())
    return FilterConfig(**data.get("filters", {}))


def load_config_from_db(conn, user_id: str) -> FilterConfig:
    """Load the filter config from the DB (the `filter_entries` table).

    This is the production path (config lives in the DB, reachable from both the
    pipeline and the web layer). ``load_config`` (TOML file) remains for the
    one-time seed and local inspection.
    """
    from app import db  # local import avoids a config↔db import cycle

    grouped = db.get_filter_entries(conn, user_id)
    return FilterConfig(
        sender_allowlist=grouped.get("sender_allowlist", []),
        sender_blocklist=grouped.get("sender_blocklist", []),
        subject_keywords=grouped.get("subject_keywords", []),
        body_keywords=grouped.get("body_keywords", []),
    )


def load_effective_config(user_id: str, file_path: Path | str = "kin.toml") -> FilterConfig:
    """The config source the pipeline should use.

    Production (``TURSO_DATABASE_URL`` set) reads from the DB; local dev and tests
    read the TOML file. Selected by the same env var as ``db.connect()``, so the
    web layer and the pipeline stay consistent within each environment.
    """
    if os.environ.get("TURSO_DATABASE_URL"):
        from app import db

        conn = db.connect("")  # Turso; path ignored
        try:
            return load_config_from_db(conn, user_id)
        finally:
            conn.close()
    return load_config(file_path)

"""Helpers shared between kin CLI entry points (triage, digest, ...)."""
import argparse
import logging
import os
import sqlite3
import sys
from pathlib import Path


def resolve_db_path() -> Path:
    """`$KIN_DB_PATH` → `data/kin.sqlite` default."""
    env_path = os.environ.get("KIN_DB_PATH")
    if env_path:
        return Path(env_path)
    return Path("data") / "kin.sqlite"


def args_for_persistence(args: argparse.Namespace) -> dict:
    """Return a JSON-safe snapshot of CLI args for the runs/digests args column."""
    return {k: (str(v) if isinstance(v, Path) else v) for k, v in vars(args).items()}


def setup_logging() -> None:
    """Configure root logging to stderr at $KIN_LOG_LEVEL (default INFO)."""
    logging.basicConfig(
        level=os.environ.get("KIN_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )


def connect_db_ro(path: Path, *, expected_schema_version: str) -> sqlite3.Connection:
    """Open the DB read-only via SQLite's URI form.

    Verifies `_meta.schema_version` equals `expected_schema_version`; raises
    `RuntimeError` on mismatch so the caller can map it to `EXIT_DB`.
    Raises `sqlite3.OperationalError` if the file is missing or unreadable.
    """
    if not path.exists():
        raise sqlite3.OperationalError(f"DB not found at {path}")
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT value FROM _meta WHERE key = 'schema_version'"
    ).fetchone()
    if row is None:
        conn.close()
        raise RuntimeError(f"DB at {path} is missing _meta.schema_version")
    if row["value"] != expected_schema_version:
        conn.close()
        raise RuntimeError(
            f"DB schema_version is {row['value']!r}, expected "
            f"{expected_schema_version!r}; re-run a writeable command (e.g. triage) "
            "to migrate."
        )
    return conn

"""Read OAuth tokens written by the web/ layer to the shared token store."""
import json
import os
from pathlib import Path


def read_refresh_token(email: str, *, path: Path) -> str | None:
    """Return the stored refresh token for *email* from the JSON file, or None.

    Returns None (without raising) when the file does not exist or does not
    contain an entry for *email*.
    """
    try:
        data = json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    return data.get(email, {}).get("refresh_token")


def read_effective_refresh_token(email: str, *, path: Path) -> str | None:
    """The token source the pipeline should use.

    Production (``TURSO_DATABASE_URL`` set) reads from the DB; local dev and tests
    read the JSON file. Mirrors ``config.load_effective_config``.
    """
    if os.environ.get("TURSO_DATABASE_URL"):
        from app import db

        conn = db.connect("")  # Turso; path ignored
        try:
            return db.read_refresh_token(conn, email)
        finally:
            conn.close()
    return read_refresh_token(email, path=path)

"""Read OAuth tokens written by the web/ layer to the shared token store."""
import json
from pathlib import Path


def read_refresh_token(email: str, *, path: Path) -> str | None:
    """Return the stored refresh token for *email*, or None if not found.

    Returns None (without raising) when the file does not exist or does not
    contain an entry for *email*.
    """
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    return data.get(email, {}).get("refresh_token")

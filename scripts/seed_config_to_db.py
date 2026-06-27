"""Seed the filter config (kin.toml) and the Gmail token store
(data/gmail_tokens.json) into the DB — a one-time migration per database.

Local SQLite:
    uv run python scripts/seed_config_to_db.py [user_id]
Turso:
    set -a; . ./.env.turso; set +a; uv run python scripts/seed_config_to_db.py [user_id]

Idempotent: filter entries use INSERT OR IGNORE and tokens upsert, so re-running
is safe.
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from app import db
from app.cli_common import resolve_db_path
from app.config import load_config

USER = sys.argv[1] if len(sys.argv) > 1 else "jerome"
GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"


def main() -> int:
    conn = db.connect(resolve_db_path())

    toml_path = Path(os.environ.get("KIN_TOML_PATH", "kin.toml"))
    if toml_path.exists():
        cfg = load_config(toml_path)
        for kind, values in (
            ("sender_allowlist", cfg.sender_allowlist),
            ("sender_blocklist", cfg.sender_blocklist),
            ("subject_keywords", cfg.subject_keywords),
            ("body_keywords", cfg.body_keywords),
        ):
            if values:
                n = db.add_filter_entries(conn, user_id=USER, kind=kind, values=values)
                print(f"filter {kind}: +{n} (of {len(values)})")
    else:
        print(f"no {toml_path} — skipping filter config")

    tokens_path = Path(os.environ.get("KIN_TOKEN_STORE_PATH", "data/gmail_tokens.json"))
    if tokens_path.exists():
        store = json.loads(tokens_path.read_text())
        now = datetime.now(timezone.utc)
        for email, entry in store.items():
            rt = entry.get("refresh_token")
            if rt:
                db.write_refresh_token(
                    conn,
                    email=email,
                    refresh_token=rt,
                    scope=entry.get("scope", GMAIL_SCOPE),
                    now=now,
                )
                print(f"token: {email}")
    else:
        print(f"no {tokens_path} — skipping tokens")

    conn.commit()
    conn.close()
    print("SEED DONE")
    # libsql-client (Turso) leaves a background thread; hard-exit once done.
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main())

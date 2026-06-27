"""Per-user Gmail ingestion orchestrator.

Runs the pipeline unchanged from app/triage.py:
  pre-filter (app.email_filters.should_classify)
  → classify (app.classify_email.classify)
  → persist (app.db.upsert_email + app.db.insert_classification)

then builds and persists the user's daily digest.

ADR-007: ~40 lines of orchestration are deliberately duplicated from
triage.py to avoid editing app/ — do not refactor a shared loop.
"""
import argparse
import logging
import os
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from app import db
from app.classify_email import MODEL, PROMPT_VERSION, classify
from app.config import load_config
from app.digest import build_digest, render_json, render_markdown
from app.email_filters import should_classify
from app.email_source import EmailSource, FetchedEmail

logger = logging.getLogger("kin.ingest")

# Exit codes — defined here so route.ts maps a single source (story-005-003).
EXIT_OK = 0
EXIT_REAUTH = 2     # ReauthRequired
EXIT_CONFIG = 3     # missing creds / token store / config
EXIT_DB = 4         # sqlite write failure


@dataclass
class IngestionResult:
    fetched: int
    filtered: int
    classified: int
    reused: int
    errors: int
    digest_id: int | None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _render_for_model(msg: FetchedEmail) -> str:
    """Concatenate headers + body into the plain-text shape the classifier expects."""
    lines = [
        f"From: {msg.from_addr}",
        f"To: {', '.join(msg.to_addrs)}",
    ]
    if msg.cc_addrs:
        lines.append(f"Cc: {', '.join(msg.cc_addrs)}")
    lines.extend([
        f"Subject: {msg.subject}",
        f"Date: {msg.date.isoformat()}",
        "",
        msg.text_body,
    ])
    return "\n".join(lines)


def run_ingestion(
    *,
    user_email: str,
    hours: int = 24,
    limit: int = 50,
    db_path: Path,
    config_path: Path,
    token_store_path: Path,
    source: EmailSource | None = None,
) -> IngestionResult:
    """Ingest recent Gmail for `user_email` and build a per-user daily digest.

    `source` defaults to GmailSource backed by a minted access credential;
    pass a fake source in tests to avoid Gmail calls.

    Raises ReauthRequired, FileNotFoundError, RuntimeError, or
    sqlite3.DatabaseError — `main()` maps each to an EXIT_* code.
    """
    try:
        cfg = load_config(config_path)
    except FileNotFoundError:
        raise
    except Exception as exc:
        raise RuntimeError(f"invalid config in {config_path}: {exc}") from exc

    # Resolve the source (and credentials) BEFORE opening the DB so that a
    # missing or revoked token does not leave an empty DB on disk.
    if source is None:
        from ingest.gmail_source import GmailSource
        from ingest.oauth import mint_access_credentials
        from ingest.token_store import read_refresh_token

        refresh_token = read_refresh_token(user_email, path=token_store_path)
        if refresh_token is None:
            raise FileNotFoundError(
                f"No refresh token for {user_email!r} in {token_store_path}"
            )
        client_id = os.environ.get("AUTH_GOOGLE_ID", "")
        client_secret = os.environ.get("AUTH_GOOGLE_SECRET", "")
        if not client_id or not client_secret:
            raise RuntimeError(
                "AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET must be set"
            )
        creds = mint_access_credentials(
            refresh_token=refresh_token,
            client_id=client_id,
            client_secret=client_secret,
        )
        source = GmailSource(creds)

    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn: sqlite3.Connection | None = None
    try:
        conn = db.connect(db_path)

        fetched = filtered = classified = reused = errors = 0
        now = _utcnow()

        for msg in source.fetch_recent(hours=hours, limit=limit):
            fetched += 1

            if not should_classify(msg, cfg):
                continue
            filtered += 1

            try:
                with conn:
                    email_id = db.upsert_email(
                        conn,
                        user_id=user_email,
                        folder="INBOX",
                        msg=msg,
                        now=now,
                    )
            except sqlite3.DatabaseError as exc:
                logger.warning(
                    "DB upsert_email failed message_id=%s: %s",
                    msg.message_id, exc,
                )
                errors += 1
                continue

            cached = db.find_classification(
                conn,
                email_id=email_id,
                model=MODEL,
                prompt_version=PROMPT_VERSION,
            )
            if cached is not None:
                reused += 1
                continue

            try:
                result = classify(_render_for_model(msg))
            except Exception as exc:
                errors += 1
                logger.warning(
                    "classification failed message_id=%s: %s",
                    msg.message_id, exc,
                )
                continue

            try:
                with conn:
                    db.insert_classification(
                        conn,
                        email_id=email_id,
                        run_id=None,
                        model=MODEL,
                        prompt_version=PROMPT_VERSION,
                        result=result,
                        truncated=msg.truncated,
                        now=now,
                    )
                classified += 1  # only after a successful commit
            except sqlite3.DatabaseError as exc:
                logger.warning(
                    "DB insert_classification failed message_id=%s: %s",
                    msg.message_id, exc,
                )
                errors += 1

        digest = build_digest(
            conn,
            user_id=user_email,
            hours=hours,
            model=MODEL,
            prompt_version=PROMPT_VERSION,
            now=_utcnow(),
            include_other=False,
        )

        try:
            md = render_markdown(digest)
            js = render_json(digest)
        except Exception as exc:
            raise RuntimeError(f"digest render failed: {exc}") from exc

        try:
            digest_id = db.insert_digest(
                conn,
                user_id=user_email,
                generated_at=datetime.fromisoformat(digest.generated_at),
                window_hours=digest.window_hours,
                window_start=datetime.fromisoformat(digest.window_start),
                window_end=datetime.fromisoformat(digest.window_end),
                model=MODEL,
                prompt_version=PROMPT_VERSION,
                include_other=digest.include_other,
                args={"user_email": user_email, "hours": hours, "limit": limit},
                classified_count=digest.classified_count,
                actionable_count=digest.actionable_count,
                informational_count=digest.informational_count,
                skipped_other_count=digest.skipped_other_count,
                dropped_low_count=digest.dropped_low_count,
                classification_ids=[i.classification_id for i in digest.items],
                markdown=md,
                json_payload=js,
            )
        except sqlite3.DatabaseError as exc:
            logger.warning("digest persistence failed: %s", exc)
            digest_id = None

        return IngestionResult(
            fetched=fetched,
            filtered=filtered,
            classified=classified,
            reused=reused,
            errors=errors,
            digest_id=digest_id,
        )

    finally:
        if conn is not None:
            conn.close()


def main() -> int:
    from app.cli_common import setup_logging
    from ingest.oauth import ReauthRequired

    setup_logging()
    load_dotenv()

    p = argparse.ArgumentParser(
        description="kin ingestion: fetch Gmail, classify, and persist per-user rows."
    )
    p.add_argument("--user", required=True,
                   help="User email address — sets user_id on every persisted row.")
    p.add_argument("--hours", type=int, default=24,
                   help="Look-back window in hours (default 24).")
    p.add_argument("--limit", type=int, default=50,
                   help="Max messages to fetch (default 50).")
    p.add_argument("--config", type=Path, default=Path("kin.toml"))
    p.add_argument(
        "--db",
        dest="db_path",
        type=Path,
        default=Path(os.environ.get("KIN_DB_PATH", "data/kin.sqlite")),
    )
    p.add_argument(
        "--token-store",
        type=Path,
        default=Path(
            os.environ.get("KIN_TOKEN_STORE_PATH", "data/gmail_tokens.json")
        ),
    )
    args = p.parse_args()

    try:
        result = run_ingestion(
            user_email=args.user,
            hours=args.hours,
            limit=args.limit,
            db_path=args.db_path,
            config_path=args.config,
            token_store_path=args.token_store,
        )
    except ReauthRequired as exc:
        logger.error("Gmail token revoked or expired — re-auth required: %s", exc)
        return EXIT_REAUTH
    except FileNotFoundError as exc:
        logger.error("config or token not found: %s", exc)
        return EXIT_CONFIG
    except RuntimeError as exc:
        logger.error("config error: %s", exc)
        return EXIT_CONFIG
    except sqlite3.DatabaseError as exc:
        logger.error("DB write failure: %s", exc)
        return EXIT_DB

    logger.info(
        "fetched=%d filtered=%d classified=%d reused=%d errors=%d digest_id=%s",
        result.fetched, result.filtered, result.classified,
        result.reused, result.errors, result.digest_id,
    )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

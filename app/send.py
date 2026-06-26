"""kin send — assemble and deliver the latest digest as a multipart/alternative email.

Reads data/kin.sqlite read-only. No writes, no IMAP, no LLM calls.
"""
import argparse
import logging
import os
import smtplib
import sqlite3
import sys
from email.message import EmailMessage

from dotenv import load_dotenv

from app import db
from app.cli_common import connect_db_ro, resolve_db_path, setup_logging
from app.digest import Digest
from app.email_render import render_html, render_subject, render_text
from app.exit_codes import EXIT_CONFIG, EXIT_DB, EXIT_OK, EXIT_UNEXPECTED

logger = logging.getLogger("kin.send")

_DEFAULT_SMTP_HOST = "smtp.gmail.com"
_DEFAULT_SMTP_PORT = 587


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def resolve_recipient() -> str:
    """KIN_DIGEST_TO if set, else GMAIL_ADDRESS."""
    return os.environ.get("KIN_DIGEST_TO") or os.environ["GMAIL_ADDRESS"]


def build_message(digest: Digest, *, sender: str, recipient: str) -> EmailMessage:
    """multipart/alternative: text part first, then html part."""
    msg = EmailMessage()
    msg["Subject"] = render_subject(digest)
    msg["From"] = sender
    msg["To"] = recipient
    msg.set_content(render_text(digest))
    msg.add_alternative(render_html(digest), subtype="html")
    return msg


def send_via_smtp(
    msg: EmailMessage,
    *,
    host: str,
    port: int,
    username: str,
    password: str,
) -> None:
    """SMTP(host, port) → starttls() → login() → send_message()."""
    with smtplib.SMTP(host, port) as smtp:
        smtp.starttls()
        smtp.login(username, password)
        smtp.send_message(msg)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "kin send: email the latest daily digest. "
            "Reads only — no IMAP, no LLM."
        ),
    )
    p.add_argument(
        "--user",
        default=os.environ.get("KIN_USER", "jerome"),
        help="User scope (default $KIN_USER or 'jerome').",
    )
    p.add_argument(
        "--digest-id",
        type=int,
        default=None,
        help="Send a specific past digest by id instead of the latest.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the full RFC822 message to stdout; open no socket.",
    )
    return p


def main() -> int:
    setup_logging()
    args = _build_parser().parse_args()
    load_dotenv()

    # --- credential pre-flight (EXIT_CONFIG before any network activity) ---
    gmail_address = os.environ.get("GMAIL_ADDRESS")
    gmail_password = os.environ.get("GMAIL_APP_PASSWORD")
    if not gmail_address:
        logger.error(
            "GMAIL_ADDRESS is not set; export it or add it to .env"
        )
        return EXIT_CONFIG
    if not gmail_password:
        logger.error(
            "GMAIL_APP_PASSWORD is not set; export it or add it to .env"
        )
        return EXIT_CONFIG

    # --- open DB read-only ---
    db_path = resolve_db_path()
    try:
        conn = connect_db_ro(db_path, expected_schema_version=db.SCHEMA_VERSION)
    except (sqlite3.OperationalError, sqlite3.DatabaseError) as exc:
        logger.error("DB open failed at %s: %s", db_path, exc)
        return EXIT_DB
    except RuntimeError as exc:
        logger.error("DB schema problem: %s", exc)
        return EXIT_DB

    try:
        # --- fetch digest payload ---
        if args.digest_id is not None:
            payload = db.fetch_digest_json(conn, digest_id=args.digest_id)
            if payload is None:
                logger.error("no digest with id %d", args.digest_id)
                return EXIT_CONFIG
            digest = Digest.from_json(payload)
            if digest.user_id != args.user:
                logger.error(
                    "digest %d belongs to user %r, not %r",
                    args.digest_id,
                    digest.user_id,
                    args.user,
                )
                return EXIT_CONFIG
        else:
            payload = db.fetch_latest_digest_json(
                conn, user_id=args.user, window_hours=24
            )
            if payload is None:
                logger.error(
                    "no daily digest (window_hours=24) found for user %r. "
                    "Run `app.digest` first, or pass --digest-id N.",
                    args.user,
                )
                return EXIT_CONFIG
            digest = Digest.from_json(payload)

        # --- resolve SMTP config ---
        smtp_host = os.environ.get("SMTP_HOST", _DEFAULT_SMTP_HOST)
        smtp_port = int(os.environ.get("SMTP_PORT", _DEFAULT_SMTP_PORT))

        # --- resolve recipient ---
        try:
            recipient = resolve_recipient()
        except KeyError:
            logger.error(
                "No recipient: set KIN_DIGEST_TO or GMAIL_ADDRESS"
            )
            return EXIT_CONFIG

        # --- build message ---
        msg = build_message(digest, sender=gmail_address, recipient=recipient)

        # --- dry-run: print and exit without touching the network ---
        if args.dry_run:
            sys.stdout.write(msg.as_string())
            if not msg.as_string().endswith("\n"):
                sys.stdout.write("\n")
            return EXIT_OK

        # --- send ---
        try:
            send_via_smtp(
                msg,
                host=smtp_host,
                port=smtp_port,
                username=gmail_address,
                password=gmail_password,
            )
        except smtplib.SMTPException as exc:
            logger.error("SMTP send failed: %s", exc)
            return EXIT_UNEXPECTED

        logger.info(
            "sent digest (id=%s) to %s via %s:%d",
            args.digest_id,
            recipient,
            smtp_host,
            smtp_port,
        )
        return EXIT_OK

    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())

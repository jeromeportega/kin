"""kin email triage CLI.

Fetches recent mail from the configured `EmailSource`, applies the
deterministic pre-filter, and runs survivors through the local Ollama
classifier. Emits one JSON Lines record per processed message to stdout
(and optionally to `--out`). Never mutates the mailbox.

By default, results persist to a local SQLite database (`data/kin.sqlite`
or whatever `$KIN_DB_PATH` points at). On re-runs, classifications with
the same `(model, prompt_version)` are loaded from the DB instead of
re-classifying — a prompt change invalidates the cache automatically.
`--no-db` skips persistence entirely; `--force-reclassify` re-classifies
even cache hits.
"""
import argparse
import json
import logging
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import IO

from dotenv import load_dotenv

from app import db
from app.cli_common import args_for_persistence, resolve_db_path, setup_logging
from app.classify_email import MODEL, PROMPT_VERSION, classify
from app.config import load_effective_config
from app.email_filters import should_classify
from app.email_source import FetchedEmail
from app.exit_codes import (
    EXIT_CONFIG,
    EXIT_DB,
    EXIT_IMAP,
    EXIT_MODEL,
    EXIT_OK,
    EXIT_UNEXPECTED,
)
from app.imap_source import IMAPSource

logger = logging.getLogger("kin.triage")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="kin: triage recent Gmail with a local model."
    )
    p.add_argument("--hours", type=int, default=24,
                   help="Look back this many hours (default 24).")
    p.add_argument("--limit", type=int, default=200,
                   help="Hard cap on messages classified per run (default 200).")
    p.add_argument("--out", type=Path, default=None,
                   help="Also write JSONL to this path.")
    p.add_argument("--dry-run", action="store_true",
                   help="Skip LLM classification; just print filter survivors.")
    p.add_argument("--model", default=MODEL,
                   help=f"Ollama model tag (default {MODEL}).")
    p.add_argument("--config", type=Path, default=Path("kin.toml"),
                   help="Path to kin.toml (default kin.toml).")
    p.add_argument("--no-db", action="store_true",
                   help="Skip all DB interaction (Phase-2-equivalent stateless run).")
    p.add_argument("--force-reclassify", action="store_true",
                   help="Ignore cached classifications; re-classify even cache hits.")
    p.add_argument("--user", default=os.environ.get("KIN_USER", "jerome"),
                   help="User scope (default $KIN_USER or 'jerome').")
    return p


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
        f"Date: {msg.date.isoformat() if msg.date else ''}",
        "",
        msg.text_body,
    ])
    return "\n".join(lines)


def _emit(record: dict, extra: IO[str] | None) -> None:
    line = json.dumps(record, ensure_ascii=False, default=str)
    print(line)
    if extra is not None:
        extra.write(line + "\n")
        extra.flush()


def main() -> int:  # noqa: C901 — orchestrator, intentionally linear
    setup_logging()
    args = _build_parser().parse_args()

    load_dotenv()

    try:
        cfg = load_effective_config(args.user, args.config)
    except FileNotFoundError as exc:
        logger.error("%s", exc)
        return EXIT_CONFIG
    except Exception as exc:  # malformed TOML, pydantic validation, etc.
        logger.error("invalid config in %s: %s", args.config, exc)
        return EXIT_CONFIG

    try:
        host = os.environ["IMAP_HOST"]
        port = int(os.environ.get("IMAP_PORT", "993"))
        user = os.environ["GMAIL_ADDRESS"]
        password = os.environ["GMAIL_APP_PASSWORD"]
    except KeyError as exc:
        logger.error("missing required env var %s — see .env.example", exc)
        return EXIT_CONFIG

    source = IMAPSource(host=host, port=port, user=user, password=password)

    # DB connection — open before anything mutates state.
    conn: sqlite3.Connection | None = None
    if not args.no_db:
        db_path = resolve_db_path()
        try:
            db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = db.connect(db_path)
        except (sqlite3.DatabaseError, OSError) as exc:
            logger.error("DB open failed at %s: %s", db_path, exc)
            return EXIT_DB
        except RuntimeError as exc:
            logger.error("DB schema problem: %s", exc)
            return EXIT_DB

    started = time.monotonic()
    fetched = filtered = classified = reused = errors = truncated = 0
    extra_fh: IO[str] | None = None
    run_id: int | None = None

    try:
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            extra_fh = args.out.open("w")

        try:
            stream = source.fetch_recent(hours=args.hours, limit=args.limit)
        except Exception as exc:
            logger.error("IMAP fetch failed: %s", exc)
            return EXIT_IMAP

        # Once we've got the IMAP stream, record the run. If IMAP login fails
        # mid-iteration, the finally block still records counters via finish_run.
        if conn is not None:
            try:
                with conn:
                    run_id = db.start_run(
                        conn,
                        user_id=args.user,
                        args=args_for_persistence(args),
                        model=args.model,
                        prompt_version=PROMPT_VERSION,
                        hours=args.hours,
                        limit_n=args.limit,
                        now=_utcnow(),
                    )
            except sqlite3.DatabaseError as exc:
                logger.error("DB start_run failed: %s", exc)
                return EXIT_DB

        try:
            for msg in stream:
                fetched += 1
                if msg.truncated:
                    truncated += 1
                if not should_classify(msg, cfg):
                    continue
                filtered += 1

                base = {
                    "message_id": msg.message_id,
                    "uid": msg.uid,
                    "from": msg.from_addr,
                    "subject": msg.subject,
                    "date": msg.date.isoformat() if msg.date else None,
                    "truncated": msg.truncated,
                    "model": args.model,
                    "prompt_version": PROMPT_VERSION,
                }

                if args.dry_run:
                    _emit({**base, "source": "filter"}, extra_fh)
                    continue

                # Persist email metadata; check for a cached classification.
                email_id: int | None = None
                if conn is not None:
                    try:
                        with conn:
                            email_id = db.upsert_email(
                                conn,
                                user_id=args.user,
                                folder="INBOX",
                                msg=msg,
                                now=_utcnow(),
                            )
                    except sqlite3.DatabaseError as exc:
                        logger.warning(
                            "DB upsert_email failed message_id=%s: %s",
                            msg.message_id, exc,
                        )

                    if email_id is not None and not args.force_reclassify:
                        cached = db.find_classification(
                            conn,
                            email_id=email_id,
                            model=args.model,
                            prompt_version=PROMPT_VERSION,
                        )
                        if cached is not None:
                            reused += 1
                            _emit(
                                {**base, "source": "db", "classification": cached},
                                extra_fh,
                            )
                            continue

                # Cache miss (or --no-db, or --force-reclassify): call the model.
                try:
                    result = classify(_render_for_model(msg), model=args.model)
                except Exception as exc:
                    errors += 1
                    err_text = f"{type(exc).__name__}: {exc}"
                    logger.warning(
                        "classification failed message_id=%s: %s",
                        msg.message_id, err_text,
                    )
                    if conn is not None and email_id is not None:
                        try:
                            with conn:
                                db.insert_classification_error(
                                    conn,
                                    email_id=email_id,
                                    run_id=run_id,
                                    model=args.model,
                                    prompt_version=PROMPT_VERSION,
                                    error=err_text,
                                    truncated=msg.truncated,
                                    now=_utcnow(),
                                )
                        except sqlite3.DatabaseError as db_exc:
                            logger.warning(
                                "DB insert_classification_error failed: %s",
                                db_exc,
                            )
                    _emit({**base, "source": "error", "error": err_text}, extra_fh)
                    continue

                classified += 1
                if conn is not None and email_id is not None:
                    try:
                        with conn:
                            db.insert_classification(
                                conn,
                                email_id=email_id,
                                run_id=run_id,
                                model=args.model,
                                prompt_version=PROMPT_VERSION,
                                result=result,
                                truncated=msg.truncated,
                                now=_utcnow(),
                            )
                    except sqlite3.DatabaseError as db_exc:
                        logger.warning(
                            "DB insert_classification failed message_id=%s: %s",
                            msg.message_id, db_exc,
                        )
                _emit(
                    {
                        **base,
                        "source": "classifier",
                        "classification": result.model_dump(mode="json"),
                    },
                    extra_fh,
                )
        except Exception as exc:
            logger.error("IMAP iteration failed: %s", exc)
            return EXIT_IMAP
    finally:
        if extra_fh is not None:
            extra_fh.close()
        if conn is not None and run_id is not None:
            try:
                with conn:
                    db.finish_run(
                        conn,
                        run_id=run_id,
                        fetched=fetched,
                        filtered=filtered,
                        classified=classified,
                        reused=reused,
                        errors=errors,
                        truncated=truncated,
                        now=_utcnow(),
                    )
            except sqlite3.DatabaseError as exc:
                logger.warning("DB finish_run failed: %s", exc)
        if conn is not None:
            conn.close()

    elapsed = time.monotonic() - started
    logger.info(
        "fetched=%d filtered=%d classified=%d reused=%d errors=%d truncated=%d elapsed=%.1fs",
        fetched, filtered, classified, reused, errors, truncated, elapsed,
    )

    if filtered > 0 and classified == 0 and errors == filtered and not args.dry_run:
        return EXIT_MODEL
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

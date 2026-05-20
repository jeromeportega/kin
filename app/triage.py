"""kin email triage CLI.

Fetches recent mail from the configured `EmailSource`, applies the
deterministic pre-filter, and runs survivors through the local Ollama
classifier. Emits one JSON Lines record per processed message to stdout
(and optionally to `--out`). Never mutates the mailbox.
"""
import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import IO

from dotenv import load_dotenv

from app.classify_email import MODEL, PROMPT_VERSION, classify
from app.config import load_config
from app.email_filters import should_classify
from app.email_source import FetchedEmail
from app.imap_source import IMAPSource

logger = logging.getLogger("kin.triage")

EXIT_OK = 0
EXIT_UNEXPECTED = 1
EXIT_CONFIG = 2
EXIT_IMAP = 3
EXIT_MODEL = 4


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
    return p


def _setup_logging() -> None:
    logging.basicConfig(
        level=os.environ.get("KIN_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )


def _render_for_model(msg: FetchedEmail) -> str:
    """Concatenate headers + body into the plain-text shape the existing
    classifier expects."""
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


def main() -> int:
    _setup_logging()
    args = _build_parser().parse_args()

    load_dotenv()

    try:
        cfg = load_config(args.config)
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

    started = time.monotonic()
    fetched = filtered = classified = errors = truncated = 0
    extra_fh: IO[str] | None = None

    try:
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            extra_fh = args.out.open("w")

        try:
            stream = source.fetch_recent(hours=args.hours, limit=args.limit)
        except Exception as exc:
            logger.error("IMAP fetch failed: %s", exc)
            return EXIT_IMAP

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
                    _emit(base, extra_fh)
                    continue

                try:
                    result = classify(_render_for_model(msg), model=args.model)
                except Exception as exc:
                    errors += 1
                    logger.warning(
                        "classification failed message_id=%s: %s",
                        msg.message_id, exc,
                    )
                    _emit({**base, "error": f"{type(exc).__name__}: {exc}"}, extra_fh)
                    continue

                classified += 1
                _emit(
                    {**base, "classification": result.model_dump(mode="json")},
                    extra_fh,
                )
        except Exception as exc:
            logger.error("IMAP iteration failed: %s", exc)
            return EXIT_IMAP
    finally:
        if extra_fh is not None:
            extra_fh.close()

    elapsed = time.monotonic() - started
    logger.info(
        "fetched=%d filtered=%d classified=%d errors=%d truncated=%d elapsed=%.1fs",
        fetched, filtered, classified, errors, truncated, elapsed,
    )

    if filtered > 0 and classified == 0 and errors == filtered and not args.dry_run:
        return EXIT_MODEL
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

"""Mail sampler / sender audit — a config-bootstrap helper, not part of the
triage runtime.

Fetches recent messages from a single IMAP folder, groups by sender, and
prints a frequency table with sample subjects. Use this to figure out
who belongs in your `kin.toml` allowlist (recurring senders in INBOX)
and who belongs in the blocklist (senders that pile up in `[Gmail]/Trash`).

The triage CLI (`app.triage`) still only touches `INBOX`. This is a
separate tool with a separate purpose; the read-only `mark_seen=False`
behavior carries over.

Usage:
    uv run python -m app.audit                              # last 7 days of INBOX
    uv run python -m app.audit --folder "[Gmail]/Trash"     # see what got trashed
    uv run python -m app.audit --days 30 --min-count 3      # bigger window, busier senders
"""
import argparse
import logging
import os
import sys
from collections import Counter, defaultdict

from dotenv import load_dotenv

from app.imap_source import IMAPSource


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit recent senders to bootstrap kin.toml.")
    parser.add_argument("--folder", default="INBOX",
                        help="IMAP folder to scan (default INBOX). Common alternatives: '[Gmail]/Trash', '[Gmail]/Spam'.")
    parser.add_argument("--days", type=int, default=7, help="Look back this many days (default 7).")
    parser.add_argument("--limit", type=int, default=2000, help="Hard cap on messages fetched (default 2000).")
    parser.add_argument("--min-count", type=int, default=2,
                        help="Only print senders with at least this many messages (default 2).")
    parser.add_argument("--max-subjects", type=int, default=3,
                        help="Sample this many subjects per sender (default 3).")
    args = parser.parse_args()

    logging.basicConfig(level=os.environ.get("KIN_LOG_LEVEL", "WARNING"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s",
                        stream=sys.stderr)
    load_dotenv()

    try:
        host = os.environ["IMAP_HOST"]
        port = int(os.environ.get("IMAP_PORT", "993"))
        user = os.environ["GMAIL_ADDRESS"]
        password = os.environ["GMAIL_APP_PASSWORD"]
    except KeyError as exc:
        print(f"Missing env var {exc} — see .env.example", file=sys.stderr)
        return 2

    source = IMAPSource(host=host, port=port, user=user, password=password,
                        folders=(args.folder,))
    hours = args.days * 24

    counts: Counter[str] = Counter()
    subjects: dict[str, list[str]] = defaultdict(list)
    total = 0
    for msg in source.fetch_recent(hours=hours, limit=args.limit):
        total += 1
        counts[msg.from_addr] += 1
        if len(subjects[msg.from_addr]) < args.max_subjects:
            subjects[msg.from_addr].append(msg.subject)

    shown = [s for s, n in counts.items() if n >= args.min_count]
    width = max((len(s) for s in shown), default=10)

    print(f"\nFolder: {args.folder}   window: last {args.days} days   "
          f"messages: {total}   distinct senders: {len(counts)}")
    print(f"(showing senders with >= {args.min_count} messages)\n")

    for sender, n in counts.most_common():
        if n < args.min_count:
            continue
        print(f"  {n:>3}  {sender:<{width}}")
        for subj in subjects[sender]:
            trimmed = (subj[:80] + "…") if len(subj) > 80 else subj
            print(f"         - {trimmed}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""kin daily digest — reads classifications from `data/kin.sqlite` and renders
a human-facing summary (markdown) plus a structured JSON document.

Triage populates the DB; digest reads it. No IMAP, no LLM calls in this CLI.
By default persists a record of each invocation to `digests` / `digest_items`
for future analysis and renderer regression testing. `--no-persist` opts out.
"""
import argparse
import json
import logging
import sqlite3
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import IO

from dotenv import load_dotenv

from app import db
from app.classify_email import MODEL, PROMPT_VERSION
from app.cli_common import (
    args_for_persistence,
    connect_db_ro,
    resolve_db_path,
    setup_logging,
)
from app.exit_codes import EXIT_CONFIG, EXIT_DB, EXIT_OK, EXIT_UNEXPECTED

logger = logging.getLogger("kin.digest")


_PRIORITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --- data structures --------------------------------------------------------


@dataclass(frozen=True)
class DigestItem:
    classification_id: int
    message_id: str
    uid: str | None
    from_addr: str
    subject: str
    date: str  # ISO 8601 UTC, email's Date: header
    category: str
    priority: str
    action_required: bool
    summary: str
    action_items: list[str]
    dates: list[str]
    confidence: float
    model: str
    prompt_version: str
    classified_at: str


@dataclass(frozen=True)
class Digest:
    generated_at: str                  # ISO 8601 UTC
    user_id: str
    model: str | None                  # None when default "latest per email"
    prompt_version: str | None
    window_hours: int
    window_start: str                  # ISO 8601 UTC
    window_end: str                    # ISO 8601 UTC
    include_other: bool
    classified_count: int
    actionable_count: int
    informational_count: int
    skipped_other_count: int
    dropped_low_count: int
    items: list[DigestItem] = field(default_factory=list)

    def to_json(self) -> str:
        payload = asdict(self)
        return json.dumps(payload, indent=2, ensure_ascii=False)

    @classmethod
    def from_json(cls, s: str) -> "Digest":
        data = json.loads(s)
        raw_items = data.pop("items", [])
        return cls(items=[DigestItem(**item) for item in raw_items], **data)


# --- build ------------------------------------------------------------------


def build_digest(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    hours: int,
    model: str | None,
    prompt_version: str | None,
    now: datetime,
    include_other: bool,
) -> Digest:
    """Pull classifications in window, apply filter + grouping rules, return Digest.

    Universal invariant: `len(items) == actionable_count + informational_count`.
    Universal invariant: `classified_count == len(items) + (skipped_other_count
    if not include_other else 0) + dropped_low_count`.
    """
    if now.tzinfo is None:
        raise ValueError("now must be tz-aware")
    window_end = now
    window_start = now - timedelta(hours=hours)

    rows = db.fetch_classifications_window(
        conn,
        user_id=user_id,
        window_start=window_start,
        window_end=window_end,
        model=model,
        prompt_version=prompt_version,
    )

    classified_count = len(rows)
    actionable_count = informational_count = 0
    skipped_other_count = dropped_low_count = 0
    items: list[DigestItem] = []

    for r in rows:
        cat = r["category"]
        pri = r["priority"]
        act = r["action_required"]

        # `other`: always increment the gross count, optionally include in items.
        if cat == "other":
            skipped_other_count += 1
            if not include_other:
                continue

        # Routing: high/medium always shown; low only if actionable; else dropped.
        if pri == "high" or pri == "medium":
            shown = True
        elif pri == "low" and act:
            shown = True
        else:
            dropped_low_count += 1
            shown = False

        if not shown:
            continue

        if act:
            actionable_count += 1
        else:
            informational_count += 1

        items.append(
            DigestItem(
                classification_id=r["classification_id"],
                message_id=r["message_id"],
                uid=r["uid"],
                from_addr=r["from_addr"],
                subject=r["subject"],
                date=r["email_date"],
                category=cat,
                priority=pri,
                action_required=act,
                summary=r["summary"],
                action_items=r["action_items"],
                dates=r["dates"],
                confidence=r["confidence"],
                model=r["model"],
                prompt_version=r["prompt_version"],
                classified_at=r["classified_at"],
            )
        )

    # Sort: by priority (high → medium → low), then category alphabetical,
    # then date descending (newest first within a category).
    items.sort(
        key=lambda i: (
            _PRIORITY_ORDER.get(i.priority, 99),
            0 if i.action_required else 1,  # actionable first within priority
            i.category,
            -_iso_to_epoch(i.date),
        )
    )

    return Digest(
        generated_at=now.isoformat(),
        user_id=user_id,
        model=model,
        prompt_version=prompt_version,
        window_hours=hours,
        window_start=window_start.isoformat(),
        window_end=window_end.isoformat(),
        include_other=include_other,
        classified_count=classified_count,
        actionable_count=actionable_count,
        informational_count=informational_count,
        skipped_other_count=skipped_other_count,
        dropped_low_count=dropped_low_count,
        items=items,
    )


def _iso_to_epoch(s: str) -> float:
    """Parse ISO 8601 (with or without tz) into a sortable epoch float."""
    try:
        return datetime.fromisoformat(s).timestamp()
    except (TypeError, ValueError):
        return 0.0


# --- renderers --------------------------------------------------------------


def _md_escape(s: str) -> str:
    """Escape backticks and pipes for markdown rendering. Other characters
    pass through (we trust subjects/summaries to be plain text)."""
    return s.replace("`", r"\`").replace("|", r"\|")


def _local(s: str) -> str:
    """Render an ISO 8601 UTC string in the system local timezone."""
    try:
        dt = datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return s
    return dt.astimezone().strftime("%Y-%m-%d %H:%M %Z").strip()


def render_markdown(digest: Digest) -> str:
    lines: list[str] = []

    header_dt = _local(digest.generated_at)
    lines.append(f"# kin daily digest — {header_dt}")
    lines.append("")

    summary_bits = [
        f"Window: last {digest.window_hours} hours",
        f"{digest.classified_count} classified",
        f"{digest.actionable_count} actionable",
        f"{digest.informational_count} informational",
    ]
    if digest.skipped_other_count and not digest.include_other:
        summary_bits.append(f"{digest.skipped_other_count} skipped as `other`")
    if digest.dropped_low_count:
        summary_bits.append(
            f"{digest.dropped_low_count} low-priority FYIs hidden"
        )
    lines.append(" · ".join(summary_bits))
    lines.append("")

    if not digest.items:
        if digest.skipped_other_count and not digest.include_other:
            lines.append("## Skipped")
            lines.append("")
            lines.append(
                f"{digest.skipped_other_count} emails were classified as "
                "`other` (marketing, social, FYI) and are not shown above."
            )
            lines.append("")
        return "\n".join(lines).rstrip() + "\n"

    # Group items by priority then category for rendering.
    by_priority: dict[str, list[DigestItem]] = {"high": [], "medium": [], "low": []}
    for item in digest.items:
        by_priority.setdefault(item.priority, []).append(item)

    sections = [
        ("🚨 High priority", by_priority.get("high", [])),
        ("⚠️ Medium priority", by_priority.get("medium", [])),
        ("ℹ️ Low priority — actionable", by_priority.get("low", [])),
    ]
    for heading, group in sections:
        if not group:
            continue
        lines.append(f"## {heading} ({len(group)})")
        lines.append("")

        by_category: dict[str, list[DigestItem]] = {}
        for item in group:
            by_category.setdefault(item.category, []).append(item)
        for category in sorted(by_category):
            cat_items = by_category[category]
            lines.append(f"### {category} ({len(cat_items)})")
            lines.append("")
            for item in cat_items:
                lines.extend(_render_item_md(item))
                lines.append("")

    if digest.skipped_other_count and not digest.include_other:
        lines.append("## Skipped")
        lines.append("")
        lines.append(
            f"{digest.skipped_other_count} emails were classified as `other` "
            "(marketing, social, FYI) and are not shown above."
        )
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def _render_item_md(item: DigestItem) -> list[str]:
    out: list[str] = []
    out.append(f"- **{_md_escape(item.subject) or '(no subject)'}**")
    out.append(
        f"  - From: {_md_escape(item.from_addr)} · {_local(item.date)}"
    )
    if item.dates:
        out.append("  - Dates: " + ", ".join(item.dates))
    if item.summary:
        out.append(f"  - _{_md_escape(item.summary)}_")
    if item.action_items:
        out.append("  - Actions:")
        for action in item.action_items:
            out.append(f"    - {_md_escape(action)}")
    return out


def render_json(digest: Digest) -> str:
    return digest.to_json()


# --- CLI --------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "kin daily digest: summarize classifications from data/kin.sqlite. "
            "Reads only — no IMAP, no LLM."
        ),
    )
    p.add_argument("--hours", type=int, default=24,
                   help="Window over email Date (not classified_at). Default 24.")
    p.add_argument("--user",
                   default=__import__("os").environ.get("KIN_USER", "jerome"),
                   help="User scope (default $KIN_USER or 'jerome').")
    p.add_argument("--out-md", default=None,
                   help="Also write markdown to this path; `-` for stdout.")
    p.add_argument("--out-json", default=None,
                   help="Also write JSON to this path; `-` for stdout.")
    p.add_argument("--include-other", action="store_true",
                   help="Include category='other' items in the rendered groups.")
    p.add_argument("--no-persist", action="store_true",
                   help="Skip writing this digest to the digests table.")
    forensics = p.add_argument_group("Forensics")
    forensics.add_argument("--model", default=None,
                           help="Filter to a specific model's classifications "
                                "(defaults to latest-per-email).")
    forensics.add_argument("--prompt-version", default=None,
                           help="Filter to a specific prompt version (with --model).")
    return p


def _write_file(target: str | None, content: str) -> None:
    """Write `content` to file `target` if it's a real path (not `-` and not None)."""
    if target is None or target == "-":
        return
    path = Path(target)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def _emit_stdout(content: str) -> None:
    sys.stdout.write(content)
    if not content.endswith("\n"):
        sys.stdout.write("\n")


def main() -> int:
    setup_logging()
    args = _build_parser().parse_args()
    load_dotenv()

    # Connection — read-only when --no-persist, read/write otherwise.
    conn: sqlite3.Connection | None = None
    db_path = resolve_db_path()
    try:
        if args.no_persist:
            conn = connect_db_ro(db_path, expected_schema_version=db.SCHEMA_VERSION)
        else:
            db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = db.connect(db_path)
    except (sqlite3.OperationalError, sqlite3.DatabaseError) as exc:
        logger.error("DB open failed at %s: %s", db_path, exc)
        return EXIT_DB
    except RuntimeError as exc:
        logger.error("DB schema problem: %s", exc)
        return EXIT_DB

    try:
        try:
            digest = build_digest(
                conn,
                user_id=args.user,
                hours=args.hours,
                model=args.model,
                prompt_version=args.prompt_version,
                now=_utcnow(),
                include_other=args.include_other,
            )
        except (ValueError, sqlite3.DatabaseError) as exc:
            logger.error("digest build failed: %s", exc)
            return EXIT_DB

        md = render_markdown(digest)
        js = render_json(digest)

        if not args.no_persist:
            try:
                db.insert_digest(
                    conn,
                    user_id=args.user,
                    generated_at=datetime.fromisoformat(digest.generated_at),
                    window_hours=digest.window_hours,
                    window_start=datetime.fromisoformat(digest.window_start),
                    window_end=datetime.fromisoformat(digest.window_end),
                    model=digest.model or MODEL,
                    prompt_version=digest.prompt_version or PROMPT_VERSION,
                    include_other=digest.include_other,
                    args=args_for_persistence(args),
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
                logger.error("digest persistence failed: %s", exc)
                return EXIT_DB

        # Output: markdown to stdout by default. `--out-json -` switches stdout
        # to JSON (replaces markdown). `--out-md` and `--out-json` to a real path
        # always write that file too, regardless of what stdout contains.
        if args.out_json == "-":
            _emit_stdout(js)
        else:
            _emit_stdout(md)

        _write_file(args.out_md, md)
        _write_file(args.out_json, js)

        logger.info(
            "classified=%d actionable=%d informational=%d skipped_other=%d "
            "dropped_low=%d items=%d",
            digest.classified_count,
            digest.actionable_count,
            digest.informational_count,
            digest.skipped_other_count,
            digest.dropped_low_count,
            len(digest.items),
        )

        return EXIT_OK
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())

"""kin sync — export the latest digest to Obsidian (markdown) and Calendar (ICS).

Reads `data/kin.sqlite` read-only. Writes markdown files into
`<vault>/kin/{digests,emails}/` (Obsidian picks them up automatically;
no plugin required) and an `.ics` file (default `runs/kin-<date>.ics`)
that can be imported into Google Calendar / Apple Calendar.

Sync is idempotent — same input produces the same files. Filenames and
event UIDs are UUID5-derived from `message_id`, so re-imports update
existing entries rather than duplicating them.
"""
import argparse
import logging
import os
import sqlite3
import sys
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from app import db
from app.cli_common import (
    connect_db_ro,
    resolve_db_path,
    setup_logging,
)
from app.digest import Digest
from app.exit_codes import EXIT_CONFIG, EXIT_DB, EXIT_OK
from app.ics import render_calendar
from app.obsidian import render_daily_note, render_email_note, slug_for_email

logger = logging.getLogger("kin.sync")


# ----------------------------------------------------------------------------
# Time helpers
# ----------------------------------------------------------------------------

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _local_date_from_iso(iso_str: str) -> date:
    """Return the local-time date for an ISO 8601 (UTC or aware) string."""
    dt = datetime.fromisoformat(iso_str)
    if dt.tzinfo is None:
        return dt.date()
    return dt.astimezone().date()


# ----------------------------------------------------------------------------
# Argparse
# ----------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "kin sync: export the latest daily digest to Obsidian (markdown) "
            "and an ICS calendar file."
        ),
    )
    p.add_argument("--user", default=os.environ.get("KIN_USER", "jerome"),
                   help="User scope (default $KIN_USER or 'jerome').")
    p.add_argument("--digest-id", type=int, default=None,
                   help="Sync a specific past digest by id instead of the latest.")
    p.add_argument("--vault-path", type=Path, default=None,
                   help="Obsidian vault root (overrides $KIN_OBSIDIAN_VAULT).")
    p.add_argument("--ics-path", default=None,
                   help="Path for the ICS file; `-` means stdout. "
                        "Default: runs/kin-<YYYY-MM-DD>.ics.")
    p.add_argument("--no-obsidian", action="store_true",
                   help="Skip vault writes entirely.")
    p.add_argument("--no-ics", action="store_true",
                   help="Skip ICS export entirely.")
    p.add_argument("--dry-run", action="store_true",
                   help="Print planned file paths; write nothing.")
    return p


def _resolve_vault_path(args: argparse.Namespace) -> Path | None:
    if args.vault_path:
        return args.vault_path
    env = os.environ.get("KIN_OBSIDIAN_VAULT")
    return Path(env) if env else None


# ----------------------------------------------------------------------------
# Atomic file write
# ----------------------------------------------------------------------------

def _atomic_write(path: Path, content: str) -> None:
    """Write `content` to `path` atomically.

    The tmp file lives in `path.parent` (same filesystem), so `os.replace` is
    truly atomic — not a copy+unlink fallback as it would be across volumes.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=path.parent,
        mode="w",
        encoding="utf-8",
        delete=False,
        suffix=".tmp",
    ) as tf:
        tf.write(content)
        tmp_path = tf.name
    os.replace(tmp_path, path)


# ----------------------------------------------------------------------------
# Path validation
# ----------------------------------------------------------------------------

def _assert_under_vault_kin(path: Path, vault_path: Path) -> None:
    """Defense-in-depth: every Obsidian write must land under `<vault>/kin/`."""
    target = path.resolve()
    kin = (vault_path / "kin").resolve()
    try:
        target.relative_to(kin)
    except ValueError as exc:
        raise RuntimeError(
            f"refusing to write outside vault/kin: {target} not under {kin}"
        ) from exc


# ----------------------------------------------------------------------------
# Write planning
# ----------------------------------------------------------------------------

def _plan_vault_writes(
    digest: Digest,
    vault_path: Path,
    *,
    now: datetime,
) -> list[tuple[Path, str]]:
    """Build the list of (path, content) for all vault writes."""
    kin_dir = vault_path / "kin"
    emails_dir = kin_dir / "emails"
    digests_dir = kin_dir / "digests"

    slug_lookup: dict[int, str] = {}
    writes: list[tuple[Path, str]] = []

    for item in digest.items:
        email_date = _local_date_from_iso(item.date)
        slug = slug_for_email(item.message_id, item.subject, email_date)
        slug_lookup[item.classification_id] = slug
        note_path = emails_dir / f"{slug}.md"
        writes.append((note_path, render_email_note(item, synced_at=now)))

    local_date = _local_date_from_iso(digest.generated_at)
    daily_path = digests_dir / f"{local_date.isoformat()}.md"
    writes.append((
        daily_path,
        render_daily_note(digest, slug_lookup, synced_at=now, local_date=local_date),
    ))
    return writes


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def main() -> int:
    setup_logging()
    args = _build_parser().parse_args()
    load_dotenv()

    # Resolve vault & ICS paths.
    vault_path = _resolve_vault_path(args)
    if not args.no_obsidian and vault_path is None:
        logger.error(
            "No vault path: set $KIN_OBSIDIAN_VAULT or pass --vault-path, "
            "or use --no-obsidian to skip Obsidian writes."
        )
        return EXIT_CONFIG

    now = _utcnow()
    now_local_date = now.astimezone().date()

    ics_target: Path | None
    ics_to_stdout = False
    if args.no_ics:
        ics_target = None
    elif args.ics_path == "-":
        ics_target = None
        ics_to_stdout = True
    elif args.ics_path:
        ics_target = Path(args.ics_path)
    else:
        ics_target = Path("runs") / f"kin-{now_local_date.isoformat()}.ics"

    # Open DB read-only and fetch the digest payload.
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
        if args.digest_id is not None:
            payload = db.fetch_digest_json(conn, digest_id=args.digest_id)
            if payload is None:
                logger.error("no digest with id %d", args.digest_id)
                return EXIT_CONFIG
        else:
            payload = db.fetch_latest_digest_json(
                conn, user_id=args.user, window_hours=24,
            )
            if payload is None:
                logger.error(
                    "no daily digest (window_hours=24) found for user %r. "
                    "Run `app.digest` first, or pass --digest-id N.",
                    args.user,
                )
                return EXIT_CONFIG

        digest = Digest.from_json(payload)

        # Plan vault writes (if any) and ICS content (if any).
        vault_writes: list[tuple[Path, str]] = []
        if not args.no_obsidian and vault_path is not None:
            vault_writes = _plan_vault_writes(digest, vault_path, now=now)
            for path, _ in vault_writes:
                _assert_under_vault_kin(path, vault_path)

        ics_content: str | None = None
        if ics_target is not None or ics_to_stdout:
            ics_content = render_calendar(digest.items, now)

        # Dry-run: just print planned paths.
        if args.dry_run:
            for path, _ in vault_writes:
                print(path)
            if ics_target is not None:
                print(ics_target)
            elif ics_to_stdout:
                print("(ICS to stdout)")
            return EXIT_OK

        # Real run.
        for path, content in vault_writes:
            _atomic_write(path, content)

        if ics_target is not None and ics_content is not None:
            _atomic_write(ics_target, ics_content)
        elif ics_to_stdout and ics_content is not None:
            sys.stdout.write(ics_content)

        logger.info(
            "wrote vault_files=%d ics_path=%s",
            len(vault_writes),
            ics_target if ics_target else ("stdout" if ics_to_stdout else "skipped"),
        )
        return EXIT_OK
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())

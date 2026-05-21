"""Obsidian vault renderers — pure functions, no I/O.

Filenames use a deterministic UUID5 derived from `message_id`, so re-syncing
the same email overwrites the same file. Frontmatter is emitted via
`yaml.safe_dump` to handle subjects with colons, quotes, leading dashes, etc.
without silently corrupting the YAML block.
"""
import re
import uuid
from datetime import date, datetime
from typing import Mapping

import yaml

from app.digest import Digest, DigestItem


# Fixed namespace under which all kin UUIDs are derived. Stable forever.
KIN_UUID_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_DNS, "kin.local")


# Filesystem-illegal + Obsidian-illegal characters in subjects.
_SUBJECT_STRIP_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f#\^\[\]]')
_WHITESPACE_RE = re.compile(r"\s+")


# Daily-note rendering: section ordering.
_SECTION_HEADERS = [
    ("high", "🚨 High priority"),
    ("medium", "⚠️ Medium priority"),
    ("low", "ℹ️ Low priority — actionable"),
]


# ----------------------------------------------------------------------------
# Identity
# ----------------------------------------------------------------------------

def email_uuid(message_id: str) -> uuid.UUID:
    """Deterministic UUID5 for a `message_id` under the kin namespace."""
    return uuid.uuid5(KIN_UUID_NAMESPACE, message_id)


def slug_for_email(message_id: str, subject: str, email_date: date) -> str:
    """Stable, filesystem-safe, Obsidian-safe slug for a per-email note.

    Format: `<YYYY-MM-DD> - <sanitized subject ≤60 chars> - <uuid5(message_id)>`.
    Whitespace-only subjects fall back to "no-subject"; the slug is never empty.
    """
    date_part = email_date.strftime("%Y-%m-%d")
    cleaned = _SUBJECT_STRIP_RE.sub("", subject or "")
    cleaned = _WHITESPACE_RE.sub(" ", cleaned).strip()
    if not cleaned:
        cleaned = "no-subject"
    cleaned = cleaned[:60]
    return f"{date_part} - {cleaned} - {email_uuid(message_id)}"


# ----------------------------------------------------------------------------
# Tags
# ----------------------------------------------------------------------------

def tags_for_item(item: DigestItem) -> list[str]:
    """Stable, deduplicated tag list for one digest item."""
    tags = ["kin", item.category]
    if item.priority in ("high", "medium"):
        tags.append(f"{item.priority}-priority")
    if item.action_required:
        tags.append("actionable")
    seen: set[str] = set()
    deduped: list[str] = []
    for t in tags:
        if t not in seen:
            seen.add(t)
            deduped.append(t)
    return deduped


# ----------------------------------------------------------------------------
# Frontmatter
# ----------------------------------------------------------------------------

def _safe_dump_frontmatter(data: Mapping) -> str:
    """Render a YAML frontmatter block bracketed by `---` fences."""
    body = yaml.safe_dump(
        dict(data),
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    )
    return f"---\n{body}---\n"


# ----------------------------------------------------------------------------
# Time helpers
# ----------------------------------------------------------------------------

def _local_time_str(iso_utc: str) -> str:
    """Render an ISO 8601 (UTC) string in the system local timezone."""
    try:
        dt = datetime.fromisoformat(iso_utc)
    except (TypeError, ValueError):
        return iso_utc
    return dt.astimezone().strftime("%Y-%m-%d %H:%M %Z").strip()


# ----------------------------------------------------------------------------
# Per-email note
# ----------------------------------------------------------------------------

def render_email_note(item: DigestItem, *, synced_at: datetime) -> str:
    """Render the full markdown for an email note (frontmatter + body)."""
    front = {
        "message_id": item.message_id,
        "date": item.date,
        "from": item.from_addr,
        "subject": item.subject,
        "category": item.category,
        "priority": item.priority,
        "action_required": item.action_required,
        "confidence": item.confidence,
        "model": item.model,
        "prompt_version": item.prompt_version,
        "classified_at": item.classified_at,
        "synced_at": synced_at.isoformat(),
        "tags": tags_for_item(item),
    }

    parts: list[str] = [_safe_dump_frontmatter(front)]
    parts.append(f"# {item.subject or '(no subject)'}")
    parts.append("")
    parts.append(f"**From:** {item.from_addr}")
    parts.append(f"**Received:** {_local_time_str(item.date)}")
    parts.append("")

    if item.summary:
        parts.append("## Summary")
        parts.append("")
        parts.append(item.summary)
        parts.append("")

    if item.action_items:
        parts.append("## Action items")
        parts.append("")
        for action in item.action_items:
            parts.append(f"- [ ] {action}")
        parts.append("")

    if item.dates:
        parts.append("## Dates")
        parts.append("")
        for d in item.dates:
            parts.append(f"- {d}")
        parts.append("")

    return "\n".join(parts).rstrip() + "\n"


# ----------------------------------------------------------------------------
# Daily digest note
# ----------------------------------------------------------------------------

def render_daily_note(
    digest: Digest,
    slug_lookup: Mapping[int, str],
    *,
    synced_at: datetime,
    local_date: date,
) -> str:
    """Render the daily digest note. `slug_lookup` maps `classification_id` → slug."""
    front = {
        "date": local_date.isoformat(),
        "tags": ["kin", "digest"],
        "classified": digest.classified_count,
        "actionable": digest.actionable_count,
        "informational": digest.informational_count,
        "skipped_other": digest.skipped_other_count,
        "dropped_low": digest.dropped_low_count,
        "model": digest.model,
        "prompt_version": digest.prompt_version,
        "window_hours": digest.window_hours,
        "synced_at": synced_at.isoformat(),
    }

    parts: list[str] = [_safe_dump_frontmatter(front)]
    parts.append(f"# kin daily digest — {local_date.isoformat()}")
    parts.append("")

    summary_bits = [
        f"Window: last {digest.window_hours} hours",
        f"{digest.classified_count} classified",
        f"{digest.actionable_count} actionable",
        f"{digest.informational_count} informational",
    ]
    if digest.skipped_other_count and not digest.include_other:
        summary_bits.append(f"{digest.skipped_other_count} skipped as `other`")
    if digest.dropped_low_count:
        summary_bits.append(f"{digest.dropped_low_count} low-priority FYIs hidden")
    parts.append(" · ".join(summary_bits))
    parts.append("")

    by_priority: dict[str, list[DigestItem]] = {"high": [], "medium": [], "low": []}
    for item in digest.items:
        by_priority.setdefault(item.priority, []).append(item)

    for key, header in _SECTION_HEADERS:
        group = by_priority.get(key, [])
        if not group:
            continue
        parts.append(f"## {header} ({len(group)})")
        parts.append("")
        by_category: dict[str, list[DigestItem]] = {}
        for item in group:
            by_category.setdefault(item.category, []).append(item)
        for cat in sorted(by_category):
            cat_items = by_category[cat]
            parts.append(f"### {cat} ({len(cat_items)})")
            parts.append("")
            for item in cat_items:
                slug = slug_lookup.get(item.classification_id, "")
                display = item.subject or "(no subject)"
                parts.append(f"- **[[kin/emails/{slug}|{display}]]**")
                parts.append(
                    f"  - From: {item.from_addr} · {_local_time_str(item.date)}"
                )
                if item.dates:
                    parts.append(f"  - Dates: {', '.join(item.dates)}")
                if item.action_items:
                    for action in item.action_items:
                        parts.append(f"  - {action}")
                parts.append("")

    if digest.skipped_other_count and not digest.include_other:
        parts.append("## Skipped")
        parts.append("")
        parts.append(
            f"{digest.skipped_other_count} emails were classified as `other` "
            "(marketing, social, FYI) and are not shown above."
        )
        parts.append("")

    return "\n".join(parts).rstrip() + "\n"

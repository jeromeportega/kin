"""Pure email renderers for kin daily digest.

No I/O, no env reads, no sockets.
"""
import html as _html
from datetime import datetime

from app.digest import Digest, DigestItem

_PRIORITY_LABELS = [
    ("High priority", "high"),
    ("Medium priority", "medium"),
    ("Low priority — actionable", "low"),
]
_KNOWN_PRIORITIES = {key for _, key in _PRIORITY_LABELS}

_NOTHING = "Nothing actionable today."


def _group_items(
    digest: Digest,
) -> list[tuple[str, list[tuple[str, list[DigestItem]]]]]:
    """Priority→category partition matching render_markdown (app/digest.py:266-290).

    Returns [(priority_label, [(category, [items])])] for non-empty buckets,
    inner categories sorted alphabetically.
    Raises ValueError for any item whose priority is not one of the three known values.
    """
    by_priority: dict[str, list[DigestItem]] = {"high": [], "medium": [], "low": []}
    for item in digest.items:
        if item.priority not in _KNOWN_PRIORITIES:
            raise ValueError(f"Unknown priority {item.priority!r}; expected one of {_KNOWN_PRIORITIES}")
        by_priority[item.priority].append(item)

    result = []
    for label, key in _PRIORITY_LABELS:
        group = by_priority[key]
        if not group:
            continue
        by_category: dict[str, list[DigestItem]] = {}
        for item in group:
            by_category.setdefault(item.category, []).append(item)
        cats = [(cat, by_category[cat]) for cat in sorted(by_category)]
        result.append((label, cats))
    return result


def render_html(digest: Digest) -> str:
    """Full HTML body string, grouped priority (high→medium→low) then sorted(category).

    Every item-derived value passes through html.escape().
    Empty digest.items => a clean 'nothing actionable today' body.
    """
    e = _html.escape
    parts: list[str] = ["<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"></head><body>"]

    if not digest.items:
        parts.append(f"<p>{_NOTHING}</p>")
        parts.append("</body></html>")
        return "\n".join(parts)

    for label, categories in _group_items(digest):
        total = sum(len(items) for _, items in categories)
        parts.append(f"<h2>{label} ({total})</h2>")
        for category, items in categories:
            parts.append(f"<h3>{e(category)} ({len(items)})</h3>")
            parts.append("<ul>")
            for item in items:
                subj = e(item.subject or "") or "(no subject)"
                parts.append(f"<li><strong>{subj}</strong><br>")
                parts.append(f"From: {e(item.from_addr)}<br>")
                if item.summary:
                    parts.append(f"<em>{e(item.summary)}</em><br>")
                if item.action_items:
                    parts.append("Actions:<ul>")
                    for action in item.action_items:
                        parts.append(f"<li>{e(action)}</li>")
                    parts.append("</ul>")
                parts.append("</li>")
            parts.append("</ul>")

    parts.append("</body></html>")
    return "\n".join(parts)


def render_text(digest: Digest) -> str:
    """Plain-text fallback over the same priority→category grouping. No markup.

    Empty digest.items => 'nothing actionable today' message.
    """
    if not digest.items:
        return f"{_NOTHING}\n"

    lines: list[str] = []
    for label, categories in _group_items(digest):
        total = sum(len(items) for _, items in categories)
        lines.append(f"== {label} ({total}) ==")
        lines.append("")
        for category, items in categories:
            lines.append(f"-- {category} ({len(items)}) --")
            lines.append("")
            for item in items:
                lines.append(f"Subject: {item.subject or '(no subject)'}")
                lines.append(f"From: {item.from_addr}")
                if item.summary:
                    lines.append(f"Summary: {item.summary}")
                if item.action_items:
                    lines.append("Actions:")
                    for action in item.action_items:
                        lines.append(f"  - {action}")
                lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def render_subject(digest: Digest, *, now_local: datetime | None = None) -> str:
    """Returns exactly: 'kin daily digest — YYYY-MM-DD · N actionable'

    N = digest.actionable_count (read from the model, never recomputed).
    Date uses system-local time; now_local is injectable for deterministic tests.
    """
    if now_local is None:
        now_local = datetime.now()
    date_str = now_local.strftime("%Y-%m-%d")
    return f"kin daily digest — {date_str} · {digest.actionable_count} actionable"

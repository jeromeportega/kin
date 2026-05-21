"""Tests for app/obsidian.py — pure renderers + slug + UUID."""
import re
import uuid
from datetime import date, datetime, timezone

import yaml

from app.digest import Digest, DigestItem
from app.obsidian import (
    email_uuid,
    render_daily_note,
    render_email_note,
    slug_for_email,
    tags_for_item,
)

SYNCED_AT = datetime(2026, 5, 20, 18, 0, 0, tzinfo=timezone.utc)
EMAIL_DATE = date(2026, 5, 20)


def _item(**overrides) -> DigestItem:
    base = dict(
        classification_id=1,
        message_id="<a@x.com>",
        uid="1",
        from_addr="s@example.com",
        subject="Subject A",
        date="2026-05-20T12:00:00+00:00",
        category="daycare",
        priority="high",
        action_required=True,
        summary="A summary.",
        action_items=["Do thing"],
        dates=["2026-05-25"],
        confidence=0.9,
        model="qwen3:14b",
        prompt_version="abc123",
        classified_at="2026-05-20T18:00:00+00:00",
    )
    base.update(overrides)
    return DigestItem(**base)


def _digest(items=None, **overrides) -> Digest:
    base = dict(
        generated_at="2026-05-20T18:00:00+00:00",
        user_id="jerome",
        model="qwen3:14b",
        prompt_version="abc",
        window_hours=24,
        window_start="2026-05-19T18:00:00+00:00",
        window_end="2026-05-20T18:00:00+00:00",
        include_other=False,
        classified_count=1,
        actionable_count=1,
        informational_count=0,
        skipped_other_count=0,
        dropped_low_count=0,
        items=items if items is not None else [_item()],
    )
    base.update(overrides)
    return Digest(**base)


def _parse_frontmatter(md: str) -> dict:
    m = re.match(r"^---\n(.*?)\n---\n", md, re.DOTALL)
    assert m, f"no frontmatter found in: {md[:200]!r}"
    return yaml.safe_load(m.group(1))


# --- email_uuid + slug -------------------------------------------------------

def test_email_uuid_deterministic():
    assert email_uuid("<a@x.com>") == email_uuid("<a@x.com>")


def test_email_uuid_differs_by_message_id():
    assert email_uuid("<a@x.com>") != email_uuid("<b@x.com>")


def test_slug_for_email_format():
    s = slug_for_email("<a@x.com>", "Hello world", EMAIL_DATE)
    assert s.startswith("2026-05-20 - Hello world - ")
    tail = s.rsplit(" - ", 1)[-1]
    uuid.UUID(tail)  # parses as a UUID


def test_slug_for_email_deterministic_same_inputs():
    a = slug_for_email("<a@x.com>", "Hello", EMAIL_DATE)
    b = slug_for_email("<a@x.com>", "Hello", EMAIL_DATE)
    assert a == b


def test_slug_for_email_distinct_message_ids():
    a = slug_for_email("<a@x.com>", "Hello", EMAIL_DATE)
    b = slug_for_email("<b@x.com>", "Hello", EMAIL_DATE)
    assert a != b


def test_slug_for_email_strips_filesystem_illegal_chars_in_subject():
    s = slug_for_email("<a@x.com>", 'foo/bar*baz?qux"<>|', EMAIL_DATE)
    subj_portion = s.split(" - ", 1)[1].rsplit(" - ", 1)[0]
    for ch in '/\\*?"<>|':
        assert ch not in subj_portion


def test_slug_for_email_strips_obsidian_illegal_chars():
    s = slug_for_email("<a@x.com>", "a#b^c[d]e", EMAIL_DATE)
    subj_portion = s.split(" - ", 1)[1].rsplit(" - ", 1)[0]
    for ch in "#^[]":
        assert ch not in subj_portion


def test_slug_for_email_empty_subject_uses_fallback():
    s = slug_for_email("<a@x.com>", "", EMAIL_DATE)
    assert "no-subject" in s


def test_slug_for_email_whitespace_only_subject_uses_fallback():
    s = slug_for_email("<a@x.com>", "   \t\n  ", EMAIL_DATE)
    assert "no-subject" in s


def test_slug_for_email_long_subject_truncated():
    s = slug_for_email("<a@x.com>", "a" * 500, EMAIL_DATE)
    subj_portion = s.split(" - ", 1)[1].rsplit(" - ", 1)[0]
    assert len(subj_portion) <= 60


# --- tags_for_item ----------------------------------------------------------

def test_tags_for_high_actionable():
    item = _item(category="medical", priority="high", action_required=True)
    tags = tags_for_item(item)
    assert tags == ["kin", "medical", "high-priority", "actionable"]


def test_tags_for_medium_not_actionable():
    item = _item(category="finance", priority="medium", action_required=False)
    tags = tags_for_item(item)
    assert "kin" in tags
    assert "finance" in tags
    assert "medium-priority" in tags
    assert "actionable" not in tags


def test_tags_for_low_actionable_omits_low_priority():
    item = _item(category="daycare", priority="low", action_required=True)
    tags = tags_for_item(item)
    assert "low-priority" not in tags
    assert "actionable" in tags


def test_tags_dedup_when_category_collides_with_kin():
    item = _item(category="kin", priority="high", action_required=False)
    tags = tags_for_item(item)
    assert tags.count("kin") == 1


# --- render_email_note frontmatter ------------------------------------------

def test_email_note_frontmatter_parses_as_yaml():
    md = render_email_note(_item(), synced_at=SYNCED_AT)
    fm = _parse_frontmatter(md)
    assert fm["message_id"] == "<a@x.com>"
    assert fm["category"] == "daycare"
    assert fm["priority"] == "high"
    assert fm["action_required"] is True   # boolean, not "true"
    assert fm["confidence"] == 0.9          # float, not "0.9"
    assert isinstance(fm["tags"], list)
    assert "kin" in fm["tags"]
    assert fm["synced_at"] == SYNCED_AT.isoformat()


def test_email_note_includes_checkboxes_for_action_items():
    md = render_email_note(
        _item(action_items=["one thing", "another thing"]),
        synced_at=SYNCED_AT,
    )
    assert "- [ ] one thing" in md
    assert "- [ ] another thing" in md


def test_email_note_omits_action_section_when_empty():
    md = render_email_note(_item(action_items=[]), synced_at=SYNCED_AT)
    assert "## Action items" not in md


def test_email_note_includes_dates_section_when_present():
    md = render_email_note(
        _item(dates=["2026-05-25", "2026-05-30"]),
        synced_at=SYNCED_AT,
    )
    assert "## Dates" in md
    assert "2026-05-25" in md
    assert "2026-05-30" in md


def test_email_note_omits_dates_section_when_empty():
    md = render_email_note(_item(dates=[]), synced_at=SYNCED_AT)
    assert "## Dates" not in md


def test_email_note_omits_summary_section_when_empty():
    md = render_email_note(_item(summary=""), synced_at=SYNCED_AT)
    assert "## Summary" not in md


# --- Adversarial subjects (YAML safety) -------------------------------------

def test_email_note_handles_subject_with_colons():
    md = render_email_note(
        _item(subject="Re: Q3 plan: action required"),
        synced_at=SYNCED_AT,
    )
    fm = _parse_frontmatter(md)
    assert fm["subject"] == "Re: Q3 plan: action required"


def test_email_note_handles_subject_with_double_quotes():
    md = render_email_note(
        _item(subject='Open the "important" attachment'),
        synced_at=SYNCED_AT,
    )
    fm = _parse_frontmatter(md)
    assert fm["subject"] == 'Open the "important" attachment'


def test_email_note_handles_subject_with_single_quotes():
    md = render_email_note(
        _item(subject="Don't forget the meeting"),
        synced_at=SYNCED_AT,
    )
    fm = _parse_frontmatter(md)
    assert fm["subject"] == "Don't forget the meeting"


def test_email_note_handles_emoji_subject():
    md = render_email_note(
        _item(subject="🎉 Your order shipped!"),
        synced_at=SYNCED_AT,
    )
    fm = _parse_frontmatter(md)
    assert fm["subject"] == "🎉 Your order shipped!"


def test_email_note_handles_leading_dash():
    md = render_email_note(_item(subject="-foo bar"), synced_at=SYNCED_AT)
    fm = _parse_frontmatter(md)
    assert fm["subject"] == "-foo bar"


def test_email_note_handles_very_long_subject():
    long = "x" * 500
    md = render_email_note(_item(subject=long), synced_at=SYNCED_AT)
    fm = _parse_frontmatter(md)
    assert fm["subject"] == long


def test_email_note_handles_message_id_with_angle_brackets():
    md = render_email_note(_item(message_id="<abc.def@x.com>"), synced_at=SYNCED_AT)
    fm = _parse_frontmatter(md)
    assert fm["message_id"] == "<abc.def@x.com>"


# --- render_daily_note ------------------------------------------------------

def test_daily_note_frontmatter_parses_as_yaml():
    digest = _digest()
    slug = slug_for_email("<a@x.com>", "Subject A", EMAIL_DATE)
    md = render_daily_note(
        digest, {1: slug}, synced_at=SYNCED_AT, local_date=EMAIL_DATE
    )
    fm = _parse_frontmatter(md)
    assert fm["date"] == "2026-05-20"
    assert isinstance(fm["tags"], list)
    assert "digest" in fm["tags"]
    assert fm["classified"] == 1
    assert fm["window_hours"] == 24


def test_daily_note_has_wikilink_per_item():
    item = _item(classification_id=42)
    digest = _digest(items=[item])
    slug = slug_for_email("<a@x.com>", "Subject A", EMAIL_DATE)
    md = render_daily_note(
        digest, {42: slug}, synced_at=SYNCED_AT, local_date=EMAIL_DATE
    )
    assert f"[[kin/emails/{slug}|Subject A]]" in md


def test_daily_note_orders_priorities():
    items = [
        _item(classification_id=1, priority="low", subject="LowSubj"),
        _item(classification_id=2, priority="medium", subject="MedSubj"),
        _item(classification_id=3, priority="high", subject="HighSubj"),
    ]
    digest = _digest(items=items, classified_count=3, actionable_count=3)
    slug_lookup = {
        i: slug_for_email(f"<{i}@x.com>", f"Subj{i}", EMAIL_DATE) for i in (1, 2, 3)
    }
    md = render_daily_note(
        digest, slug_lookup, synced_at=SYNCED_AT, local_date=EMAIL_DATE
    )
    high_pos = md.find("High priority")
    medium_pos = md.find("Medium priority")
    low_pos = md.find("Low priority")
    assert 0 <= high_pos < medium_pos < low_pos


def test_daily_note_empty_digest_still_renders():
    digest = _digest(
        items=[], classified_count=0, actionable_count=0, informational_count=0
    )
    md = render_daily_note(digest, {}, synced_at=SYNCED_AT, local_date=EMAIL_DATE)
    fm = _parse_frontmatter(md)
    assert fm["classified"] == 0
    assert "# kin daily digest" in md


def test_daily_note_skipped_section_when_count_nonzero():
    digest = _digest(skipped_other_count=12)
    slug = slug_for_email("<a@x.com>", "Subject A", EMAIL_DATE)
    md = render_daily_note(
        digest, {1: slug}, synced_at=SYNCED_AT, local_date=EMAIL_DATE
    )
    assert "## Skipped" in md or "skipped as `other`" in md


def test_daily_note_no_skipped_when_count_zero():
    digest = _digest(skipped_other_count=0)
    slug = slug_for_email("<a@x.com>", "Subject A", EMAIL_DATE)
    md = render_daily_note(
        digest, {1: slug}, synced_at=SYNCED_AT, local_date=EMAIL_DATE
    )
    assert "## Skipped" not in md

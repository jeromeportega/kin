"""Tests for the db query layer added in Phase 4 (window read, digest insert)."""
import sqlite3
from datetime import datetime, timezone

import pytest

from app.db import (
    fetch_classifications_window,
    fetch_digest_json,
    fetch_latest_digest_json,
    insert_classification,
    insert_classification_error,
    insert_digest,
    upsert_email,
)
from tests.conftest import seed_digest
from app.email_source import FetchedEmail
from app.schemas.email import Category, EmailClassification, Priority

T0 = datetime(2026, 5, 20, 12, 0, 0, tzinfo=timezone.utc)
T1 = datetime(2026, 5, 20, 13, 0, 0, tzinfo=timezone.utc)
T2 = datetime(2026, 5, 20, 14, 0, 0, tzinfo=timezone.utc)


def _email(message_id="<a@x>", date=T0) -> FetchedEmail:
    return FetchedEmail(
        uid="1",
        message_id=message_id,
        from_addr="s@example.com",
        to_addrs=("you@example.com",),
        cc_addrs=(),
        subject="hi",
        date=date,
        text_body="body",
        truncated=False,
    )


def _classification(category=Category.daycare, priority=Priority.low,
                    action=True) -> EmailClassification:
    return EmailClassification(
        category=category,
        priority=priority,
        action_required=action,
        summary="s",
        action_items=["a"],
        dates=[],
        confidence=0.9,
    )


def _setup_classified(
    mem_db, *,
    message_id="<a@x>",
    email_date=T0,
    model="m",
    prompt_version="v1",
    classified_at=T1,
    classification=None,
) -> int:
    eid = upsert_email(
        mem_db, user_id="jerome", folder="INBOX",
        msg=_email(message_id=message_id, date=email_date),
        now=T0,
    )
    insert_classification(
        mem_db, email_id=eid, run_id=None,
        model=model, prompt_version=prompt_version,
        result=classification or _classification(),
        truncated=False, now=classified_at,
    )
    return eid


# --- fetch_classifications_window -------------------------------------------

def test_fetch_window_empty_when_no_classifications(mem_db):
    assert fetch_classifications_window(
        mem_db, user_id="jerome", window_start=T0, window_end=T2,
    ) == []


def test_fetch_window_returns_in_range(mem_db):
    eid = _setup_classified(mem_db, email_date=T1)
    rows = fetch_classifications_window(
        mem_db, user_id="jerome", window_start=T0, window_end=T2,
    )
    assert len(rows) == 1
    r = rows[0]
    assert r["email_id"] == eid
    assert r["category"] == "daycare"
    assert r["action_items"] == ["a"]
    assert isinstance(r["action_required"], bool)


def test_fetch_window_ignores_outside_window(mem_db):
    _setup_classified(mem_db, message_id="<a@x>", email_date=T0)
    _setup_classified(mem_db, message_id="<b@x>", email_date=T2)
    rows = fetch_classifications_window(
        mem_db, user_id="jerome", window_start=T1, window_end=T2,
    )
    assert [r["message_id"] for r in rows] == ["<b@x>"]


def test_fetch_window_ignores_error_rows(mem_db):
    eid = upsert_email(
        mem_db, user_id="jerome", folder="INBOX",
        msg=_email(date=T1), now=T0,
    )
    insert_classification_error(
        mem_db, email_id=eid, run_id=None,
        model="m", prompt_version="v1", error="boom",
        truncated=False, now=T1,
    )
    assert fetch_classifications_window(
        mem_db, user_id="jerome", window_start=T0, window_end=T2,
    ) == []


def test_fetch_window_picks_latest_classification_per_email(mem_db):
    eid = _setup_classified(
        mem_db, email_date=T0,
        model="m", prompt_version="v1",
        classified_at=T0,
        classification=_classification(category=Category.daycare),
    )
    insert_classification(
        mem_db, email_id=eid, run_id=None,
        model="m", prompt_version="v2",
        result=_classification(category=Category.other),
        truncated=False, now=T2,
    )
    rows = fetch_classifications_window(
        mem_db, user_id="jerome", window_start=T0, window_end=T2,
    )
    assert len(rows) == 1
    assert rows[0]["prompt_version"] == "v2"
    assert rows[0]["category"] == "other"


def test_fetch_window_forensic_filter_by_model_prompt(mem_db):
    eid = _setup_classified(
        mem_db, email_date=T0,
        model="m", prompt_version="v1",
        classified_at=T0,
        classification=_classification(category=Category.daycare),
    )
    insert_classification(
        mem_db, email_id=eid, run_id=None,
        model="m", prompt_version="v2",
        result=_classification(category=Category.other),
        truncated=False, now=T2,
    )
    rows = fetch_classifications_window(
        mem_db, user_id="jerome",
        window_start=T0, window_end=T2,
        model="m", prompt_version="v1",
    )
    assert len(rows) == 1
    assert rows[0]["prompt_version"] == "v1"
    assert rows[0]["category"] == "daycare"


def test_fetch_window_rejects_naive_datetimes(mem_db):
    naive = datetime(2026, 5, 20)
    with pytest.raises(ValueError, match="tz-aware"):
        fetch_classifications_window(
            mem_db, user_id="jerome",
            window_start=naive, window_end=T2,
        )


def test_fetch_window_partial_forensic_filter_raises(mem_db):
    with pytest.raises(ValueError, match="both .* or neither"):
        fetch_classifications_window(
            mem_db, user_id="jerome",
            window_start=T0, window_end=T2,
            model="m", prompt_version=None,
        )


# --- insert_digest -----------------------------------------------------------

def test_insert_digest_roundtrip(mem_db):
    _setup_classified(mem_db)
    cls_id = mem_db.execute("SELECT id FROM classifications").fetchone()["id"]
    digest_id = insert_digest(
        mem_db,
        user_id="jerome",
        generated_at=T2, window_hours=24,
        window_start=T0, window_end=T2,
        model="m", prompt_version="v1",
        include_other=False, args={"hours": 24},
        classified_count=1,
        actionable_count=1, informational_count=0,
        skipped_other_count=0, dropped_low_count=0,
        classification_ids=[cls_id],
        markdown="# digest", json_payload='{"ok": true}',
    )
    row = mem_db.execute(
        "SELECT * FROM digests WHERE id = ?", (digest_id,)
    ).fetchone()
    assert row["classified_count"] == 1
    assert row["markdown"] == "# digest"
    assert row["json_payload"] == '{"ok": true}'

    items = mem_db.execute(
        "SELECT classification_id, position FROM digest_items "
        "WHERE digest_id = ? ORDER BY position",
        (digest_id,),
    ).fetchall()
    assert len(items) == 1
    assert items[0]["classification_id"] == cls_id
    assert items[0]["position"] == 0


def test_insert_digest_preserves_position_order(mem_db):
    _setup_classified(mem_db, message_id="<a@x>")
    _setup_classified(mem_db, message_id="<b@x>")
    cls_ids = [
        r["id"]
        for r in mem_db.execute("SELECT id FROM classifications ORDER BY id")
    ]
    digest_id = insert_digest(
        mem_db,
        user_id="jerome",
        generated_at=T2, window_hours=24,
        window_start=T0, window_end=T2,
        model="m", prompt_version="v1",
        include_other=False, args={},
        classified_count=2,
        actionable_count=2, informational_count=0,
        skipped_other_count=0, dropped_low_count=0,
        classification_ids=list(reversed(cls_ids)),
        markdown="md", json_payload="{}",
    )
    rows = mem_db.execute(
        "SELECT classification_id, position FROM digest_items "
        "WHERE digest_id = ? ORDER BY position",
        (digest_id,),
    ).fetchall()
    assert [r["classification_id"] for r in rows] == list(reversed(cls_ids))
    assert [r["position"] for r in rows] == [0, 1]


def test_insert_digest_counter_mismatch_raises(mem_db):
    _setup_classified(mem_db)
    cls_id = mem_db.execute("SELECT id FROM classifications").fetchone()["id"]
    with pytest.raises(sqlite3.IntegrityError, match="counter mismatch"):
        insert_digest(
            mem_db,
            user_id="jerome",
            generated_at=T2, window_hours=24,
            window_start=T0, window_end=T2,
            model="m", prompt_version="v1",
            include_other=False, args={},
            classified_count=1,
            actionable_count=2,         # claims 2 actionable
            informational_count=0,
            skipped_other_count=0, dropped_low_count=0,
            classification_ids=[cls_id],  # but only provides 1 id
            markdown="md", json_payload="{}",
        )


def test_insert_digest_duplicate_position_rejected_by_constraint(mem_db):
    _setup_classified(mem_db)
    cls_id = mem_db.execute("SELECT id FROM classifications").fetchone()["id"]
    digest_id = insert_digest(
        mem_db,
        user_id="jerome",
        generated_at=T2, window_hours=24,
        window_start=T0, window_end=T2,
        model="m", prompt_version="v1",
        include_other=False, args={},
        classified_count=1,
        actionable_count=1, informational_count=0,
        skipped_other_count=0, dropped_low_count=0,
        classification_ids=[cls_id],
        markdown="md", json_payload="{}",
    )
    with pytest.raises(sqlite3.IntegrityError):
        mem_db.execute(
            "INSERT INTO digest_items (digest_id, classification_id, position) "
            "VALUES (?, ?, ?)",
            (digest_id, cls_id, 0),
        )
        mem_db.commit()


# --- fetch_latest_digest_json / fetch_digest_json ---------------------------

def test_fetch_latest_digest_json_returns_none_on_empty(mem_db):
    assert fetch_latest_digest_json(mem_db, user_id="jerome") is None


def test_fetch_latest_digest_json_returns_newest(mem_db):
    seed_digest(mem_db, generated_at=T0, json_payload='{"id":1}')
    seed_digest(mem_db, generated_at=T1, json_payload='{"id":2}')
    seed_digest(mem_db, generated_at=T2, json_payload='{"id":3}')
    payload = fetch_latest_digest_json(mem_db, user_id="jerome")
    assert payload == '{"id":3}'


def test_fetch_latest_digest_json_default_filters_to_window_24(mem_db):
    seed_digest(mem_db, generated_at=T0, window_hours=720, json_payload='{"forensic":true}')
    seed_digest(mem_db, generated_at=T1, window_hours=24, json_payload='{"daily":true}')
    payload = fetch_latest_digest_json(mem_db, user_id="jerome")
    assert payload == '{"daily":true}'


def test_fetch_latest_digest_json_none_returns_latest_any_window(mem_db):
    seed_digest(mem_db, generated_at=T0, window_hours=24, json_payload='{"daily":true}')
    seed_digest(mem_db, generated_at=T1, window_hours=720, json_payload='{"forensic":true}')
    payload = fetch_latest_digest_json(mem_db, user_id="jerome", window_hours=None)
    assert payload == '{"forensic":true}'


def test_fetch_latest_digest_json_filters_by_user(mem_db):
    seed_digest(mem_db, user_id="jerome", generated_at=T0, json_payload='{"j":true}')
    seed_digest(mem_db, user_id="partner", generated_at=T1, json_payload='{"p":true}')
    assert fetch_latest_digest_json(mem_db, user_id="jerome") == '{"j":true}'
    assert fetch_latest_digest_json(mem_db, user_id="partner") == '{"p":true}'


def test_fetch_digest_json_by_id(mem_db):
    did = seed_digest(mem_db, generated_at=T0, json_payload='{"specific":true}')
    assert fetch_digest_json(mem_db, digest_id=did) == '{"specific":true}'


def test_fetch_digest_json_missing_returns_none(mem_db):
    assert fetch_digest_json(mem_db, digest_id=9999) is None


def test_fetch_digest_json_returns_old_digest_regardless_of_window(mem_db):
    # A forensic digest is fetchable by id even though fetch_latest filters to 24
    forensic_id = seed_digest(mem_db, generated_at=T0, window_hours=720,
                              json_payload='{"f":1}')
    seed_digest(mem_db, generated_at=T1, window_hours=24,
                json_payload='{"d":1}')
    assert fetch_digest_json(mem_db, digest_id=forensic_id) == '{"f":1}'

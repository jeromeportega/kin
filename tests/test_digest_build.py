"""Pure-function tests for build_digest, including a Hypothesis invariant."""
import sqlite3
from datetime import datetime, timezone

import pytest
from hypothesis import HealthCheck, given, settings, strategies as st

from app.db import init_schema, insert_classification, upsert_email
from app.digest import build_digest
from app.email_source import FetchedEmail
from app.schemas.email import Category, EmailClassification, Priority

NOW = datetime(2026, 5, 20, 18, 0, 0, tzinfo=timezone.utc)
EMAIL_TIME = datetime(2026, 5, 20, 12, 0, 0, tzinfo=timezone.utc)


def _email(msg_id: str = "<a@x>") -> FetchedEmail:
    return FetchedEmail(
        uid="1",
        message_id=msg_id,
        from_addr="s@example.com",
        to_addrs=("you@example.com",),
        cc_addrs=(),
        subject="subj",
        date=EMAIL_TIME,
        text_body="body",
        truncated=False,
    )


def _seed(conn, *, msg_id, category, priority, action,
          model="m", prompt_version="v1"):
    eid = upsert_email(
        conn, user_id="jerome", folder="INBOX",
        msg=_email(msg_id), now=EMAIL_TIME,
    )
    insert_classification(
        conn, email_id=eid, run_id=None,
        model=model, prompt_version=prompt_version,
        result=EmailClassification(
            category=category, priority=priority, action_required=action,
            summary="s", action_items=["x"] if action else [],
            dates=[], confidence=0.9,
        ),
        truncated=False, now=EMAIL_TIME,
    )


def test_build_empty(mem_db):
    digest = build_digest(
        mem_db, user_id="jerome", hours=24,
        model=None, prompt_version=None,
        now=NOW, include_other=False,
    )
    assert digest.classified_count == 0
    assert digest.actionable_count == 0
    assert digest.informational_count == 0
    assert digest.skipped_other_count == 0
    assert digest.dropped_low_count == 0
    assert digest.items == []


def test_build_skips_other_by_default(mem_db):
    _seed(mem_db, msg_id="<a@x>", category=Category.other,
          priority=Priority.low, action=False)
    digest = build_digest(
        mem_db, user_id="jerome", hours=24,
        model=None, prompt_version=None,
        now=NOW, include_other=False,
    )
    assert digest.classified_count == 1
    assert digest.skipped_other_count == 1
    assert digest.items == []


def test_build_includes_other_with_flag(mem_db):
    _seed(mem_db, msg_id="<a@x>", category=Category.other,
          priority=Priority.low, action=True)
    digest = build_digest(
        mem_db, user_id="jerome", hours=24,
        model=None, prompt_version=None,
        now=NOW, include_other=True,
    )
    assert digest.skipped_other_count == 1
    assert len(digest.items) == 1
    assert digest.items[0].category == "other"
    assert digest.actionable_count == 1


def test_build_high_priority_shown_regardless_of_action(mem_db):
    _seed(mem_db, msg_id="<a@x>", category=Category.medical,
          priority=Priority.high, action=False)
    digest = build_digest(
        mem_db, user_id="jerome", hours=24,
        model=None, prompt_version=None,
        now=NOW, include_other=False,
    )
    assert len(digest.items) == 1
    assert digest.items[0].priority == "high"
    assert digest.informational_count == 1
    assert digest.actionable_count == 0


def test_build_low_actionable_shown(mem_db):
    _seed(mem_db, msg_id="<a@x>", category=Category.daycare,
          priority=Priority.low, action=True)
    digest = build_digest(
        mem_db, user_id="jerome", hours=24,
        model=None, prompt_version=None,
        now=NOW, include_other=False,
    )
    assert len(digest.items) == 1
    assert digest.actionable_count == 1
    assert digest.dropped_low_count == 0


def test_build_low_not_actionable_dropped(mem_db):
    _seed(mem_db, msg_id="<a@x>", category=Category.finance,
          priority=Priority.low, action=False)
    digest = build_digest(
        mem_db, user_id="jerome", hours=24,
        model=None, prompt_version=None,
        now=NOW, include_other=False,
    )
    assert digest.items == []
    assert digest.dropped_low_count == 1


def test_build_orders_high_before_medium_before_low(mem_db):
    _seed(mem_db, msg_id="<a@x>", category=Category.medical,
          priority=Priority.high, action=True)
    _seed(mem_db, msg_id="<b@x>", category=Category.daycare,
          priority=Priority.low, action=True)
    _seed(mem_db, msg_id="<c@x>", category=Category.finance,
          priority=Priority.medium, action=True)
    digest = build_digest(
        mem_db, user_id="jerome", hours=24,
        model=None, prompt_version=None,
        now=NOW, include_other=False,
    )
    assert [i.priority for i in digest.items] == ["high", "medium", "low"]


# --- Hypothesis: counter invariants ----------------------------------------

CATEGORIES = st.sampled_from([
    Category.daycare, Category.medical, Category.finance, Category.travel,
    Category.shopping, Category.personal, Category.other,
])
PRIORITIES = st.sampled_from([Priority.high, Priority.medium, Priority.low])


@given(
    rows=st.lists(
        st.tuples(CATEGORIES, PRIORITIES, st.booleans()),
        min_size=0, max_size=15,
    ),
    include_other=st.booleans(),
)
@settings(max_examples=80, deadline=None,
          suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_invariants_over_random_mix(rows, include_other):
    """For any random mix, the counter invariants hold:

    1. len(items) == actionable_count + informational_count
    2. classified == len(items) + (skipped_other if not include_other else 0)
                    + dropped_low
    3. skipped_other_count == count of 'other' category rows (gross)
    """
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    init_schema(conn)
    try:
        for i, (cat, pri, act) in enumerate(rows):
            _seed(conn, msg_id=f"<{i}@x>", category=cat, priority=pri, action=act)

        digest = build_digest(
            conn, user_id="jerome", hours=24,
            model=None, prompt_version=None,
            now=NOW, include_other=include_other,
        )

        # 1. items list size matches actionable+informational
        assert len(digest.items) == digest.actionable_count + digest.informational_count

        # 2. mass conservation
        if include_other:
            assert (
                digest.classified_count
                == len(digest.items) + digest.dropped_low_count
            ), (digest, rows)
        else:
            assert (
                digest.classified_count
                == len(digest.items)
                + digest.skipped_other_count
                + digest.dropped_low_count
            ), (digest, rows)

        # 3. gross 'other' count
        expected_other = sum(1 for cat, _, _ in rows if cat == Category.other)
        assert digest.skipped_other_count == expected_other
    finally:
        conn.close()

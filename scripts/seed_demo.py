"""Seed a small demo digest into data/kin.sqlite for local dashboard smoke-testing.

Dev helper only — not part of the product pipeline. Creates a handful of recent
classified emails (so they fall in the digest's 24h window) and persists a digest
for user 'jerome', so the read-only API / dashboard have something to render.

    uv run python scripts/seed_demo.py
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import db
from app.classify_email import MODEL, PROMPT_VERSION
from app.digest import build_digest, render_json, render_markdown
from app.email_source import FetchedEmail
from app.schemas.email import Category, EmailClassification, Priority

DB_PATH = Path("data") / "kin.sqlite"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Seed under this user_id (the dashboard scopes to the signed-in email, ADR-010).
USER_ID = sys.argv[1] if len(sys.argv) > 1 else "jerome"

now = datetime.now(timezone.utc)

# (category, priority, action_required, subject, from_addr, summary, actions, dates)
SAMPLES = [
    (Category.daycare, Priority.high, True,
     "Sunshine Daycare — early pickup Friday", "admin@sunshine.example",
     "Early pickup required Friday at 2 PM for facility maintenance.",
     ["Pick up by 2:00 PM Friday"], ["2026-06-27"]),
    (Category.medical, Priority.high, True,
     "Lab results ready — follow-up requested", "noreply@health.example",
     "New lab results posted; your provider requests a follow-up call.",
     ["Call provider to review results"], ["2026-06-29"]),
    (Category.finance, Priority.medium, False,
     "Your June statement is available", "alerts@bank.example",
     "June statement is ready to view online.", [], []),
    (Category.shopping, Priority.low, True,
     "Order delivered — review requested", "orders@shop.example",
     "Your package was delivered; a review was requested.",
     ["Leave a review (optional)"], []),
    (Category.other, Priority.low, False,
     "Weekly newsletter", "news@marketing.example",
     "This week's roundup of articles.", [], []),
]

conn = db.connect(DB_PATH)
try:
    for i, (cat, pri, act, subj, frm, summ, actions, dates) in enumerate(SAMPLES):
        msg = FetchedEmail(
            uid=str(i + 1), message_id=f"<demo{i + 1}@kin>",
            from_addr=frm, to_addrs=("you@example.com",), cc_addrs=(),
            subject=subj, date=now - timedelta(hours=i + 1),
            text_body="(demo body)", truncated=False,
        )
        eid = db.upsert_email(conn, user_id=USER_ID, folder="INBOX", msg=msg, now=now)
        db.insert_classification(
            conn, email_id=eid, run_id=None, model=MODEL, prompt_version=PROMPT_VERSION,
            result=EmailClassification(
                category=cat, priority=pri, action_required=act, summary=summ,
                action_items=actions, dates=dates, confidence=0.9,
            ),
            truncated=False, now=now,
        )
    conn.commit()

    digest = build_digest(
        conn, user_id=USER_ID, hours=24, model=None, prompt_version=None,
        now=now, include_other=False,
    )
    db.insert_digest(
        conn, user_id=USER_ID, generated_at=now, window_hours=24,
        window_start=datetime.fromisoformat(digest.window_start),
        window_end=datetime.fromisoformat(digest.window_end),
        model=MODEL, prompt_version=PROMPT_VERSION, include_other=False,
        args={"seed": "demo"},
        classified_count=digest.classified_count,
        actionable_count=digest.actionable_count,
        informational_count=digest.informational_count,
        skipped_other_count=digest.skipped_other_count,
        dropped_low_count=digest.dropped_low_count,
        classification_ids=[it.classification_id for it in digest.items],
        markdown=render_markdown(digest), json_payload=render_json(digest),
    )
    print(f"seeded {DB_PATH}: classified={digest.classified_count} "
          f"actionable={digest.actionable_count} informational={digest.informational_count} "
          f"items={len(digest.items)} skipped_other={digest.skipped_other_count}")
finally:
    conn.close()

"""Schema-contract tests for api/models.py (ADR-003).

These tests assert that Pydantic model fields match the source-of-truth
dataclasses in app.digest and the documented fetch_* key lists. Any drift —
added, removed, or renamed field on either side — causes a loud build
failure instead of a silent bug.
"""
import dataclasses
import json

from app.digest import Digest, DigestItem
from api.models import ClassificationModel, DigestItemModel, DigestModel, RunModel

# ---------------------------------------------------------------------------
# Documented key sets
# ---------------------------------------------------------------------------

# Keys returned by app.db.fetch_classifications_window
_CLASSIFICATION_KEYS = {
    "classification_id", "model", "prompt_version", "category", "priority",
    "action_required", "summary", "action_items", "dates", "confidence",
    "classified_at", "email_id", "message_id", "uid", "folder",
    "from_addr", "subject", "email_date",
}

# Columns produced by app.db.fetch_runs (args excluded by design)
_RUN_KEYS = {
    "id", "user_id", "started_at", "ended_at", "hours", "limit_n",
    "model", "prompt_version", "fetched", "filtered", "classified",
    "reused", "errors", "truncated",
}

# ---------------------------------------------------------------------------
# Drift guards (ADR-003)
# ---------------------------------------------------------------------------


def test_digest_item_model_fields_match_dataclass():
    """DigestItemModel.model_fields == DigestItem dataclass fields."""
    model_fields = set(DigestItemModel.model_fields)
    dataclass_fields = {f.name for f in dataclasses.fields(DigestItem)}
    assert model_fields == dataclass_fields, (
        f"Drift detected!\n"
        f"  Model-only:     {sorted(model_fields - dataclass_fields)}\n"
        f"  Dataclass-only: {sorted(dataclass_fields - model_fields)}"
    )


def test_digest_model_fields_match_dataclass():
    """DigestModel.model_fields == Digest dataclass fields."""
    model_fields = set(DigestModel.model_fields)
    dataclass_fields = {f.name for f in dataclasses.fields(Digest)}
    assert model_fields == dataclass_fields, (
        f"Drift detected!\n"
        f"  Model-only:     {sorted(model_fields - dataclass_fields)}\n"
        f"  Dataclass-only: {sorted(dataclass_fields - model_fields)}"
    )


# ---------------------------------------------------------------------------
# Classification shape
# ---------------------------------------------------------------------------


def test_classification_model_fields_match_fetch_output():
    """ClassificationModel field set matches keys from fetch_classifications_window."""
    assert set(ClassificationModel.model_fields) == _CLASSIFICATION_KEYS


# ---------------------------------------------------------------------------
# Run shape
# ---------------------------------------------------------------------------


def test_run_model_carries_documented_columns():
    """RunModel field set matches the documented fetch_runs columns."""
    assert set(RunModel.model_fields) == _RUN_KEYS


def test_run_model_does_not_expose_args():
    """The internal args blob must never appear on RunModel."""
    assert "args" not in RunModel.model_fields


# ---------------------------------------------------------------------------
# Rehydrate round-trip
# ---------------------------------------------------------------------------

_SAMPLE_DIGEST_PAYLOAD = {
    "generated_at": "2024-01-15T12:00:00+00:00",
    "user_id": "jerome",
    "model": None,
    "prompt_version": None,
    "window_hours": 24,
    "window_start": "2024-01-14T12:00:00+00:00",
    "window_end": "2024-01-15T12:00:00+00:00",
    "include_other": False,
    "classified_count": 1,
    "actionable_count": 1,
    "informational_count": 0,
    "skipped_other_count": 0,
    "dropped_low_count": 0,
    "items": [
        {
            "classification_id": 1,
            "message_id": "<msg1@example.com>",
            "uid": None,
            "from_addr": "boss@example.com",
            "subject": "Quarterly review",
            "date": "2024-01-15T09:00:00+00:00",
            "category": "work",
            "priority": "high",
            "action_required": True,
            "summary": "Boss wants Q4 report.",
            "action_items": ["Submit Q4 report by Friday"],
            "dates": ["2024-01-19"],
            "confidence": 0.95,
            "model": "qwen3:14b",
            "prompt_version": "v1",
            "classified_at": "2024-01-15T10:00:00+00:00",
        }
    ],
}


def test_rehydrate_round_trip_no_validation_error():
    """Digest.from_json -> DigestModel(**asdict(digest)) does not raise.

    Catches type/Optional mismatches that the field-name test cannot detect,
    e.g. model/prompt_version being None.
    """
    json_str = json.dumps(_SAMPLE_DIGEST_PAYLOAD)
    digest = Digest.from_json(json_str)
    digest_dict = dataclasses.asdict(digest)
    digest_model = DigestModel(**digest_dict)

    assert digest_model.user_id == "jerome"
    assert digest_model.model is None
    assert digest_model.prompt_version is None
    assert len(digest_model.items) == 1
    assert digest_model.items[0].classification_id == 1
    assert digest_model.items[0].uid is None


def test_rehydrate_round_trip_with_non_null_model():
    """Digest with model/prompt_version set round-trips without error."""
    payload = {
        **_SAMPLE_DIGEST_PAYLOAD,
        "model": "qwen3:14b",
        "prompt_version": "v1",
    }
    digest = Digest.from_json(json.dumps(payload))
    digest_dict = dataclasses.asdict(digest)
    digest_model = DigestModel(**digest_dict)

    assert digest_model.model == "qwen3:14b"
    assert digest_model.prompt_version == "v1"


def test_rehydrate_empty_items_list():
    """Digest with no items round-trips without error."""
    payload = {
        **_SAMPLE_DIGEST_PAYLOAD,
        "classified_count": 0,
        "actionable_count": 0,
        "items": [],
    }
    digest = Digest.from_json(json.dumps(payload))
    digest_model = DigestModel(**dataclasses.asdict(digest))
    assert digest_model.items == []


# ---------------------------------------------------------------------------
# ADR-002 seam preserved
# ---------------------------------------------------------------------------


def test_per_user_seam_not_in_model_fields():
    """Commented per-user fields must NOT appear in DigestModel.model_fields.

    They are reserved for a future release (ADR-002) and must stay commented.
    """
    assert "analysis_examples" not in DigestModel.model_fields
    assert "include_rules" not in DigestModel.model_fields

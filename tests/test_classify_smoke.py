"""Smoke test for the classifier — the only Python that remains is the eval
guard (app.eval + classify_email + schemas). No API call: just verify the module
imports and the schema is intact, so a prompt/schema break is caught by the gate."""
from app.classify_email import MODEL, PROMPT_VERSION, classify
from app.schemas.email import Category, EmailClassification, Priority


def test_model_and_prompt_version():
    assert MODEL == "claude-sonnet-4-6"
    assert len(PROMPT_VERSION) == 12
    assert callable(classify)


def test_schema_fields_are_stable():
    assert set(EmailClassification.model_fields) == {
        "category",
        "priority",
        "action_required",
        "summary",
        "action_items",
        "dates",
        "confidence",
    }
    assert {c.value for c in Category} == {
        "daycare",
        "medical",
        "travel",
        "finance",
        "shopping",
        "personal",
        "other",
    }
    assert {p.value for p in Priority} == {"low", "medium", "high"}

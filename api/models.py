"""Pydantic v2 response models for the kin dashboard API.

These models mirror the frozen dataclasses in app.digest (DigestItem, Digest)
field-for-field. The drift guard in api/tests/test_models_contract.py asserts
parity at build time (ADR-003).
"""
from typing import Optional

from pydantic import BaseModel


class DigestItemModel(BaseModel):
    classification_id: int
    message_id: str
    uid: Optional[str]
    from_addr: str
    subject: str
    date: str
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


class DigestModel(BaseModel):
    generated_at: str
    user_id: str
    model: Optional[str]
    prompt_version: Optional[str]
    window_hours: int
    window_start: str
    window_end: str
    include_other: bool
    classified_count: int
    actionable_count: int
    informational_count: int
    skipped_other_count: int
    dropped_low_count: int
    items: list[DigestItemModel]
    # ADR-002 per-user seam — reserved for future personalization; not populated this release
    # analysis_examples: Optional[list[str]] = None
    # include_rules: Optional[list[str]] = None


class ClassificationModel(BaseModel):
    classification_id: int
    model: str
    prompt_version: str
    category: str
    priority: str
    action_required: bool
    summary: str
    action_items: list[str]
    dates: list[str]
    confidence: float
    classified_at: str
    email_id: int
    message_id: str
    uid: Optional[str]
    folder: str
    from_addr: str
    subject: str
    email_date: str


class RunModel(BaseModel):
    id: int
    user_id: str
    started_at: str
    ended_at: Optional[str]
    hours: Optional[int]
    limit_n: Optional[int]
    model: str
    prompt_version: str
    fetched: int
    filtered: int
    classified: int
    reused: int
    errors: int
    truncated: int

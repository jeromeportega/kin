from enum import Enum
from typing import List

from pydantic import BaseModel, Field


class Category(str, Enum):
    daycare = "daycare"
    medical = "medical"
    travel = "travel"
    finance = "finance"
    shopping = "shopping"
    personal = "personal"
    other = "other"


class Priority(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"


class Link(BaseModel):
    label: str  # short imperative CTA label, e.g. "Schedule interview"
    index: int  # 1-based bracket marker ([1], [2], ...) of the chosen link;
    # resolved to the exact URL after classification (the model never types URLs)


class Event(BaseModel):
    title: str          # short event title, e.g. "Dentist appointment"
    start: str          # ISO 8601 date or datetime (with tz if a time is given)
    end: str | None = None  # ISO 8601, when an end is stated


class EmailClassification(BaseModel):
    category: Category
    priority: Priority
    action_required: bool
    summary: str
    action_items: List[str] = Field(default_factory=list)
    dates: List[str] = Field(default_factory=list)
    links: List[Link] = Field(default_factory=list)
    events: List[Event] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)

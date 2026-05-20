"""Configuration loader for kin's pre-filter.

Parses a TOML file into a typed `FilterConfig` with normalized lists.
The default path is `kin.toml` (gitignored). See `kin.example.toml` for
the template.
"""
import tomllib
from pathlib import Path
from typing import List

from pydantic import BaseModel, Field, field_validator


class FilterConfig(BaseModel):
    sender_allowlist: List[str] = Field(default_factory=list)
    sender_blocklist: List[str] = Field(default_factory=list)
    subject_keywords: List[str] = Field(default_factory=list)
    body_keywords: List[str] = Field(default_factory=list)

    @field_validator(
        "sender_allowlist",
        "sender_blocklist",
        "subject_keywords",
        "body_keywords",
        mode="after",
    )
    @classmethod
    def _normalize(cls, value: List[str]) -> List[str]:
        return [item.strip().lower() for item in value if item.strip()]


def load_config(path: Path | str = "kin.toml") -> FilterConfig:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(
            f"Config file not found: {path}. "
            f"Copy kin.example.toml to {path} and edit it for your household."
        )
    data = tomllib.loads(path.read_text())
    return FilterConfig(**data.get("filters", {}))

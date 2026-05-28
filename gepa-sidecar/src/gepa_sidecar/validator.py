"""JSON-Schema candidate validator.

Loads `schemas/router-config.schema.json` (emitted by
`scripts/emit-config-schema.ts`) and validates every candidate config the
optimizer proposes. Invalid candidates are rejected before scoring so GEPA
gets fast feedback (and the reflection LM learns the constraint).
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

import jsonschema
from jsonschema import Draft7Validator


_DEFAULT_SCHEMA = Path(__file__).resolve().parents[3] / "schemas" / "router-config.schema.json"


@lru_cache(maxsize=4)
def _load_schema(path: str) -> dict[str, Any]:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(
            f"Config schema not found at {p}. Run "
            "`tsx scripts/emit-config-schema.ts` to generate it."
        )
    with p.open("r", encoding="utf-8") as f:
        return json.load(f)


def validate_candidate(
    candidate: dict[str, Any],
    schema_path: Path | str = _DEFAULT_SCHEMA,
) -> tuple[bool, str | None]:
    """Returns (ok, error_message_or_None)."""
    try:
        schema = _load_schema(str(schema_path))
    except FileNotFoundError as e:
        return False, str(e)

    validator = Draft7Validator(schema)
    errors = sorted(validator.iter_errors(candidate), key=lambda e: e.path)
    if not errors:
        return True, None

    parts: list[str] = []
    for err in errors[:5]:  # cap so the reflection LM gets focused feedback
        path = ".".join(str(p) for p in err.absolute_path) or "<root>"
        parts.append(f"{path}: {err.message}")
    if len(errors) > 5:
        parts.append(f"... and {len(errors) - 5} more")
    return False, "; ".join(parts)

"""Field formatting — synchronous port of ``@keyma/runtime`` ``format.ts``.

Applies every field's formatters for a given lifecycle ``phase``, in order. Each formatter is a
direct callable re-emitted into the schema metadata (no registry) returning the new value.
Formatters are synchronous (async rejected at the frontend, KEYMA026), so the driver never awaits.

Absent values (key not present) are skipped — a partial update only formats the fields it actually
carries, and formatters never run against missing values. Mutates ``value`` in place.
"""

from __future__ import annotations

from typing import Any, Dict

from ._context import Context, invoke
from .schema_fields import all_schema_fields
from .types import Metadata


def format(schema: Metadata, value: Dict[str, Any], phase: str) -> None:
    """Apply own + inherited field formatters whose ``phase`` matches, mutating ``value``."""
    context = Context(value)
    for field in all_schema_fields(schema):  # own + inherited (real inheritance)
        name = field["name"]
        if name not in value:
            continue
        for fmt in field.get("formatters") or []:
            if fmt.get("phase") != phase:
                continue
            value[name] = invoke(fmt["fn"], (value[name], context))

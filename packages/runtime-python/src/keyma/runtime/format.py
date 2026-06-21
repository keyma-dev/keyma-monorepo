"""Field formatting — port of ``@keyma/runtime-js`` ``format.ts``."""

from __future__ import annotations

from typing import Any, Dict

from ._invoke import Context, invoke_adaptive
from .types import SchemaMetadata


async def format(schema: SchemaMetadata, value: Dict[str, Any], phase: str) -> None:
    """Apply every field's formatters for the given lifecycle ``phase``, in order.
    Each formatter is a direct callable re-emitted into the schema metadata.

    Absent values (key not present) are skipped — a partial update only formats the
    fields it actually carries. Mutates ``value`` in place.
    """
    context = Context(value)
    for field in schema["fields"]:
        name = field["name"]
        if name not in value:
            continue
        for fmt in field.get("formatters") or []:
            if fmt["phase"] != phase:
                continue
            value[name] = await invoke_adaptive(fmt["fn"], (value[name], context))

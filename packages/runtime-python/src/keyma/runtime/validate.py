"""Field validation — port of ``@keyma/runtime-js`` ``validate.ts``."""

from __future__ import annotations

from typing import Any, Dict, List

from ._invoke import Context, invoke_adaptive
from .types import SchemaMetadata, ValidationError


async def validate(schema: SchemaMetadata, value: Dict[str, Any]) -> List[ValidationError]:
    """Run every field's validators. Each validator is a direct callable re-emitted
    into the schema metadata (there is no registry). A validator returns a
    :class:`ValidationError` dict or ``None``.

    Absent values (key not present) are not passed to validators: a required field
    that is missing fails with ``code: "required"``, while an optional missing field
    is skipped.
    """
    errors: List[ValidationError] = []
    context = Context(value)
    for field in schema["fields"]:
        name = field["name"]

        # An absent value skips its validators (they would otherwise trip their own
        # type guards). A required field that is absent fails with `required`; an
        # optional absent field simply has nothing to validate.
        if name not in value:
            if field.get("required") is not False:
                errors.append({"field": name, "code": "required", "message": f"{name} is required"})
            continue

        raw = value[name]
        for fn in field.get("validators") or []:
            result = await invoke_adaptive(fn, (raw, name, context))
            if result is not None:
                errors.append(result)
    return errors

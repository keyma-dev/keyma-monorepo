"""Field validation — synchronous port of ``@keyma/runtime`` ``validate.ts``.

Runs every field's validators. Each validator is a direct callable re-emitted into the schema
metadata (``field["validators"]``) — there is no name-keyed registry. A validator returns a
:class:`ValidationError` dict or ``None``. Validators are synchronous: async validators are
rejected at the frontend (KEYMA026), so the driver never awaits.

Absent values (key not present) are not passed to validators: a required field that is missing
fails with ``code: "required"``, while an optional missing field is skipped.
"""

from __future__ import annotations

from typing import Any, Dict, List, TypedDict

from ._context import Context, invoke
from .schema_fields import all_schema_fields
from .types import Metadata


class ValidationError(TypedDict):
    """A single field-level validation failure (the cross-language wire shape)."""

    field: str
    code: str
    message: str


def validate(schema: Metadata, value: Dict[str, Any]) -> List[ValidationError]:
    """Run own + inherited field validators against ``value``, accumulating every error."""
    errors: List[ValidationError] = []
    context = Context(value)
    for field in all_schema_fields(schema):  # own + inherited (real inheritance)
        name = field["name"]

        # An absent value skips its validators (they would otherwise trip their own type guards).
        # A required field that is absent fails with `required`; an optional absent field simply
        # has nothing to validate.
        if name not in value:
            if field.get("required") is not False:
                errors.append({"field": name, "code": "required", "message": f"{name} is required"})
            continue

        raw = value[name]
        for fn in field.get("validators") or []:
            result = invoke(fn, (raw, name, context))
            if result is not None:
                errors.append(result)
    return errors


def _keyma_collect(*es: object) -> list:
    """Collect the non-null candidate errors into a list — the baked collector a synthesized
    method-driven ``validate()`` lowers ``error.collect(...)`` to (the Python leg of the typed
    validator hot path; C++ uses ``keyma::collect_errors``). Nullish candidates are dropped."""
    return [e for e in es if e is not None]

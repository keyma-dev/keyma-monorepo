"""Reference value normalization — port of ``@keyma/runtime-js`` ``reference.ts``.

A ``Reference<T>`` field is stored as the referenced document's *bare id*. Callers
may supply a reference value in three forms: an id, an ``{"id": ...}`` dict, or a
full model instance. Before such a value is persisted (or sent on the wire) it is
collapsed to the bare id so the "references are stored as ids" invariant holds
regardless of input form. ``deserialize`` already accepts both the bare id and a
populated object on the read path, so only the write (``data``) and filter
(``where``) paths need this.
"""

from __future__ import annotations

from typing import Any, Dict

from .fields import all_fields
from .types import FieldType, SchemaMetadata

_SCALAR_OPS = ("$eq", "$ne", "$gt", "$gte", "$lt", "$lte")
_ARRAY_OPS = ("$in", "$nin")

_MISSING = object()


def normalize_reference_value(value: Any) -> Any:
    """Collapse a single reference value to its bare id.

    - ``None`` and bare ids (primitives) pass through,
    - an ``{"id": ...}`` dict becomes its ``id`` (even if that is ``None`` —
      surfacing bad input rather than silently persisting the wrapper),
    - a full model instance becomes its ``.id`` attribute,
    - a dict without an ``id`` key, or any other object, is left untouched,
    - lists are left to the list-aware callers below.
    """
    if value is None:
        return value
    if isinstance(value, (str, int, float, bool, bytes)):
        return value
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return value["id"] if "id" in value else value
    # Any other object (e.g. a model instance) — collapse if it carries an id.
    id_attr = getattr(value, "id", _MISSING)
    return id_attr if id_attr is not _MISSING else value


def _is_query_operator_object(value: Any) -> bool:
    """A MongoDB-style operator dict (``{"$in": [...]}``, ``{"$eq": x}``, …),
    detected by any ``$``-prefixed key, so a pathological ``{"id", "$op"}`` is
    treated as an operator object rather than collapsed by ``id``."""
    return isinstance(value, dict) and any(
        isinstance(k, str) and k.startswith("$") for k in value
    )


def normalize_reference_field_value(value: Any) -> Any:
    """Normalize the value of a single reference field. Handles operator dicts
    (normalize each operand), lists (element-wise), and scalar references."""
    if value is None:
        return value
    if _is_query_operator_object(value):
        out = dict(value)
        for op in _SCALAR_OPS:
            if op in out:
                out[op] = normalize_reference_value(out[op])
        for op in _ARRAY_OPS:
            arr = out.get(op)
            if isinstance(arr, list):
                out[op] = [normalize_reference_value(el) for el in arr]
        return out
    if isinstance(value, list):
        return [normalize_reference_value(el) for el in value]
    return normalize_reference_value(value)


def core_field_type(type_: FieldType) -> FieldType:
    """Unwrap an ``array`` field type to its element type."""
    if type_["kind"] == "array":
        return core_field_type(type_["of"])
    return type_


def normalize_reference_ids(record: Dict[str, Any], schema: SchemaMetadata) -> Dict[str, Any]:
    """Collapse every reference-typed field in a ``where``/``data`` record to bare
    id(s). Non-reference fields (including embedded objects) are passed through
    untouched. Returns a new dict; does not mutate ``record``. Must run *after*
    ``Input`` substitution, since the value behind a placeholder is only known at
    request time and may itself be an ``{"id": ...}`` dict or a full instance."""
    out = dict(record)
    for field in all_fields(schema):  # own + inherited (real inheritance)
        name = field["name"]
        if name not in out:
            continue
        if core_field_type(field["type"])["kind"] != "reference":
            continue
        out[name] = normalize_reference_field_value(out[name])
    return out

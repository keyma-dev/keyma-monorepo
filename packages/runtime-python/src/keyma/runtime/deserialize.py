"""Record deserialization / hydration — port of ``@keyma/runtime-js`` ``deserialize.ts``.

Converts ISO ``dateTime`` strings to :class:`datetime`, instantiates embedded
subobjects via the metadata ``refs`` dict, and constructs reference stubs (bare id)
or fully-populated reference instances."""

from __future__ import annotations

from typing import Any, Dict, Optional

from ._iso import from_iso
from .types import FieldType, SchemaMetadata


def deserialize(schema: SchemaMetadata, value: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    refs: Optional[Dict[str, Any]] = schema.get("refs")
    for field in schema["fields"]:
        name = field["name"]
        if name in value:
            out[name] = _deserialize_value(value[name], field["type"], refs)
    return out


def _deserialize_value(value: Any, type_: FieldType, refs: Optional[Dict[str, Any]]) -> Any:
    kind = type_["kind"]

    if kind == "dateTime" and isinstance(value, str):
        return from_iso(value)

    if kind == "embedded":
        if value is None or not isinstance(value, dict):
            return value
        sub = (refs or {}).get(type_["schema"])
        if sub is not None:
            return sub(deserialize(sub.schema, value))
        return value

    if kind == "reference":
        if value is None:
            return None
        sub = (refs or {}).get(type_["schema"])
        if sub is None:
            return value
        if isinstance(value, str):
            # Bare id — construct a stub instance with only id set.
            return sub({"id": value})
        if isinstance(value, dict):
            # Server-populated (dereferenced) — recursively deserialize then construct.
            return sub(deserialize(sub.schema, value))
        return value

    if kind == "array" and isinstance(value, list):
        return [_deserialize_value(el, type_["of"], refs) for el in value]

    return value

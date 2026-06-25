"""Record serialization — port of ``@keyma/runtime-js`` ``serialize.ts``.

Strips fields by visibility target, converts ``dateTime`` values to epoch-ms ints and
``bytes`` to base64 strings (the canonical cross-runtime wire format), and recurses into
embedded schemas via the metadata ``refs`` dict. Accepts either plain dicts or generated
model instances (attribute access, so ``@property`` getter accessors serialize too)."""

from __future__ import annotations

import base64
from datetime import datetime
from typing import Any, Dict, Optional, Tuple

from ._iso import to_epoch_ms
from .types import FieldType, SchemaMetadata, SerializeTarget


def _read(obj: Any, name: str) -> Tuple[bool, Any]:
    """Return ``(present, value)`` for ``name`` on a dict or an object instance."""
    if isinstance(obj, dict):
        return (name in obj, obj.get(name))
    if hasattr(obj, name):
        return (True, getattr(obj, name))
    return (False, None)


def _is_record(value: Any) -> bool:
    return isinstance(value, dict) or (hasattr(value, "__dict__") and not isinstance(value, (list, str, bytes)))


def serialize(schema: SchemaMetadata, value: Any, *, target: SerializeTarget) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    refs: Optional[Dict[str, Any]] = schema.get("refs")
    for field in schema["fields"]:
        if target == "client" and field.get("visibility") == "private":
            continue
        if target == "database" and field.get("ephemeral"):
            continue
        name = field["name"]
        present, raw = _read(value, name)
        if present:
            out[name] = _serialize_value(raw, field["type"], refs, target)
    return out


def _serialize_value(value: Any, type_: FieldType, refs: Optional[Dict[str, Any]], target: SerializeTarget) -> Any:
    kind = type_["kind"]
    if kind == "dateTime" and isinstance(value, datetime):
        return to_epoch_ms(value)
    if kind == "bytes" and isinstance(value, (bytes, bytearray)):
        return base64.b64encode(value).decode("ascii")
    if kind == "embedded" and value is not None and _is_record(value):
        sub = (refs or {}).get(type_["schema"])
        if sub is not None:
            return serialize(sub.schema, value, target=target)
        return value
    if kind == "array" and isinstance(value, list):
        return [_serialize_value(el, type_["of"], refs, target) for el in value]
    return value

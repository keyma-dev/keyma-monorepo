"""Record → JSON-value serialization — port of ``@keyma/runtime`` ``serialize.ts``.

Target-free and visibility-blind: every declared field is emitted (private-field exclusion is the
compile-time bundle split; ``@Ephemeral`` is a no-op). Converts ``dateTime`` values to epoch-ms
ints and ``bytes`` to base64 strings (the canonical cross-runtime wire format), and recurses into
embedded classes via the metadata ``refs`` dict. Accepts either plain dicts or generated model
instances (attribute access, so ``@property`` getters serialize too)."""

from __future__ import annotations

import base64
from datetime import datetime
from typing import Any, Dict, Optional

from ._iso import to_epoch_ms
from ._shared import Metadata, _class_meta, _is_record, _read, _ref_name
from .fields import all_fields, all_refs
from .types import FieldType


def serialize(meta: Metadata, value: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    refs = all_refs(meta)  # own + inherited (real inheritance)
    for field in all_fields(meta):
        name = field["name"]
        present, raw = _read(value, name)
        if present:
            out[name] = serialize_value(raw, field["type"], refs)
    return out


def serialize_value(value: Any, type_: FieldType, refs: Optional[Dict[str, Any]]) -> Any:
    """Serialize a single value against its IR type — also the per-arg/return codec used by the
    RPC marshaller for JSON encoding. Handles ``instance`` (param/return-only) like ``embedded``."""
    kind = type_["kind"]
    if kind == "dateTime" and isinstance(value, datetime):
        return to_epoch_ms(value)
    if kind == "bytes" and isinstance(value, (bytes, bytearray)):
        return base64.b64encode(value).decode("ascii")
    if kind in ("embedded", "instance") and value is not None and _is_record(value):
        sub = (refs or {}).get(_ref_name(type_))
        sub_meta = _class_meta(sub)
        if sub_meta is not None:
            return serialize(sub_meta, value)
        return value
    if kind == "reference":
        return _ref_id(value)
    if kind == "array" and isinstance(value, list):
        return [serialize_value(el, type_["of"], refs) for el in value]
    return value


def _ref_id(value: Any) -> Any:
    """A foreign key serializes to its target's bare id (``reference`` → ``idType`` scalar)."""
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get("id")
    if isinstance(value, (str, bytes, int, float, bool)):
        return value
    return getattr(value, "id", value)

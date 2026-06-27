"""JSON-value → record deserialization / hydration — port of ``@keyma/runtime`` ``deserialize.ts``.

Target-free and visibility-blind. Converts epoch-ms ``dateTime`` ints to :class:`datetime` and
base64 ``bytes`` strings to :class:`bytes`, hydrates embedded subobjects and reference stubs via
the metadata ``refs`` dict, calling each target class's static ``from_value`` factory (008)."""

from __future__ import annotations

import base64
from typing import Any, Dict, Optional

from ._iso import from_epoch_ms
from ._shared import Metadata, _class_meta, _hydrate, _ref_name
from .fields import all_fields, all_refs
from .types import FieldType


def deserialize(meta: Metadata, value: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    refs = all_refs(meta)  # own + inherited (real inheritance)
    for field in all_fields(meta):
        name = field["name"]
        if name in value:
            out[name] = deserialize_value(value[name], field["type"], refs)
    return out


def deserialize_value(value: Any, type_: FieldType, refs: Optional[Dict[str, Any]]) -> Any:
    """Hydrate a single value against its IR type — also the per-arg/return codec used by the RPC
    marshaller for JSON decoding. Handles ``instance`` (param/return-only) like ``embedded``."""
    kind = type_["kind"]

    if kind == "dateTime" and isinstance(value, (int, float)) and not isinstance(value, bool):
        return from_epoch_ms(value)

    if kind == "bytes" and isinstance(value, str):
        return base64.b64decode(value)

    if kind in ("embedded", "instance"):
        if value is None or not isinstance(value, dict):
            return value
        sub = (refs or {}).get(_ref_name(type_))
        sub_meta = _class_meta(sub)
        if sub_meta is not None:
            return _hydrate(sub, deserialize(sub_meta, value))
        return value

    if kind == "reference":
        if value is None:
            return None
        sub = (refs or {}).get(_ref_name(type_))
        sub_meta = _class_meta(sub)
        if sub_meta is None:
            return value
        if isinstance(value, dict):
            # Server-populated (dereferenced) — recursively deserialize then construct.
            return _hydrate(sub, deserialize(sub_meta, value))
        # Bare id — construct a stub instance with only id set.
        return _hydrate(sub, {"id": value})

    if kind == "array" and isinstance(value, list):
        return [deserialize_value(el, type_["of"], refs) for el in value]

    return value

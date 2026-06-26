"""Default application — port of ``@keyma/runtime-js`` ``defaults.ts``."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .fields import all_fields
from .types import SchemaMetadata


def apply_defaults(schema: SchemaMetadata, data: Dict[str, Any]) -> Dict[str, Any]:
    """Apply field defaults to a create payload, filling only keys that are absent
    (or ``None``). Literal defaults are read from the metadata; list defaults are
    shallow-copied so instances never share state. Expression-kind defaults are
    applied by the schema's own ``applyDefaults`` function (re-emitted runnable code
    attached to the metadata, which guards its own absent check). Mutates and
    returns ``data``.
    """
    # Literal defaults: ``all_fields`` already covers own + inherited fields.
    for field in all_fields(schema):
        default = field.get("default")
        if default is None:
            continue
        name = field["name"]
        # JS guards `name in data && data[name] !== undefined`; JSON payloads never
        # carry `undefined`, so a present key (even an explicit null) is "provided"
        # and keeps its value. Expression defaults (the schema's applyDefaults) run
        # below and apply their own None guard.
        if name in data:
            continue
        if default.get("kind") == "literal":
            value = default.get("value")
            data[name] = list(value) if isinstance(value, list) else value
        # `expression` defaults are applied by each schema's own applyDefaults below.

    # Expression defaults ride in each schema's own ``applyDefaults`` (own fields only, real
    # inheritance). Walk the base chain parent-first so an ancestor's expression defaults run
    # before the leaf's, mirroring the JS/C++ runtimes.
    chain: List[SchemaMetadata] = []
    seen = set()
    cur: Optional[SchemaMetadata] = schema
    while cur is not None and cur.get("name") not in seen:
        seen.add(cur.get("name"))
        chain.append(cur)
        cur = cur.get("base")
    for s in reversed(chain):
        apply = s.get("applyDefaults")
        if apply is not None:
            apply(data)
    return data

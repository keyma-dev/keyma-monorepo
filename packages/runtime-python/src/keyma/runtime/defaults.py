"""Field defaults — synchronous port of ``@keyma/runtime`` ``defaults.ts``.

Fills a create payload's absent keys. Literal defaults are read generically from the field
metadata (``field["default"]`` with ``kind == "literal"``; lists are shallow-copied so instances
never share state). Expression defaults (``= (() => new Date())()``, ``= my_fn()``) ride in each
schema's own ``applyDefaults`` initializer — a re-emitted callable attached directly to the
metadata that evaluates each expression per record and guards its own absent check.

The base chain is walked PARENT-FIRST so an ancestor's expression defaults run before the leaf's,
mirroring the C++/JS runtimes. Only absent keys are filled. Mutates and returns ``data``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .schema_fields import all_schema_fields
from .types import Metadata


def apply_defaults(schema: Metadata, data: Dict[str, Any]) -> Dict[str, Any]:
    """Apply literal + expression field defaults to ``data`` (absent keys only)."""
    # Literal defaults: `all_schema_fields` already covers own + inherited fields.
    for field in all_schema_fields(schema):
        default = field.get("default")
        if default is None:
            continue
        name = field["name"]
        if name in data:
            continue
        if default.get("kind") == "literal":
            value = default.get("value")
            data[name] = list(value) if isinstance(value, list) else value
        # `expression` defaults are applied by each schema's own applyDefaults below.

    # Expression defaults ride in each schema's own `applyDefaults` initializer (own fields only,
    # real inheritance). Walk the base chain leaf-first, then call PARENT-FIRST so an ancestor's
    # expression defaults run before the leaf's.
    chain: List[Metadata] = []
    seen = set()
    cur: Optional[Metadata] = schema
    while cur is not None and cur.get("name") not in seen:
        seen.add(cur.get("name"))
        chain.append(cur)
        cur = cur.get("base")
    for s in reversed(chain):
        apply = s.get("applyDefaults")
        if apply is not None:
            apply(data)
    return data

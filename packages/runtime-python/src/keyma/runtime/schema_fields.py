"""Own + inherited fields of a schema for the validation world (validate / format / defaults).

The validate/format/applyDefaults drivers operate on the legacy class-metadata shape that still
carries ``validators`` / ``formatters`` / ``default`` — the schema backend keeps emitting those
into each generated class's ``.metadata`` dict. This is DISTINCT from the codec's
:func:`keyma.runtime.fields.all_fields`, whose typed ``FieldMetadata`` view sheds those validation
keys; the two metadata worlds share the same base-first ordering but not the same field type, so
the validation world gets its own walk rather than borrowing the codec's (mirroring the JS
runtime's ``schema-fields.ts`` ``allSchemaFields`` vs ``fields.ts`` ``allFields`` split).

Assembled base-first (root → … → leaf, real inheritance): a child field overrides an inherited one
of the same name while keeping the ancestor's position, so the validated field set matches the
codec's wire order exactly. Cycle-guarded by canonical ``name``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .types import Metadata


def all_schema_fields(schema: Metadata) -> List[Dict[str, Any]]:
    base = schema.get("base")
    if base is None:
        return schema["fields"]

    # Walk the base chain leaf-first (cycle-guarded by canonical ``name``).
    chain: List[Metadata] = []
    seen = set()
    cur: Optional[Metadata] = schema
    while cur is not None and cur.get("name") not in seen:
        seen.add(cur.get("name"))
        chain.append(cur)
        cur = cur.get("base")

    # Emit root-first; a dict keyed by field name gives each field the ancestor-position of its
    # first declaration while a child override supplies the winning definition.
    by_name: Dict[str, Dict[str, Any]] = {}
    for s in reversed(chain):
        for f in s["fields"]:
            by_name[f["name"]] = f
    return list(by_name.values())

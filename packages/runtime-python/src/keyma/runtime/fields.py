"""Full field/ref set of a schema across the inheritance chain (real inheritance).

``SchemaMetadata["fields"]`` holds OWN fields only; inherited fields live on the ``base`` chain.
:func:`all_fields` assembles the complete set base-first (root → … → leaf), a child field
overriding an inherited one of the same name while keeping the ancestor's position — identical
to the order the old field-flattening pass produced, so JSON key order, binary field order, and
snapshots stay byte-stable. It mirrors the compiler's ``inheritedFields`` and the JS/C++ runtimes'
``allFields``/``all_fields``, preserving the cross-runtime wire contract.

``refs`` is likewise own-only; :func:`all_refs` resolves embedded/reference targets by walking the
chain (leaf entries shadow ancestors'). Results are cached on the schema dict's identity; schema
metadata dicts are module-level singletons built once at import.
"""

from typing import Any, Dict, List, Optional

from .types import FieldMetadata, SchemaMetadata

_fields_cache: Dict[int, List[FieldMetadata]] = {}
_refs_cache: Dict[int, Dict[str, Any]] = {}


def all_fields(schema: SchemaMetadata) -> List[FieldMetadata]:
    base = schema.get("base")
    if base is None:
        return schema["fields"]
    key = id(schema)
    memo = _fields_cache.get(key)
    if memo is not None:
        return memo

    # Walk the base chain leaf-first (cycle-guarded by canonical ``name``).
    chain: List[SchemaMetadata] = []
    seen = set()
    cur: Optional[SchemaMetadata] = schema
    while cur is not None and cur.get("name") not in seen:
        seen.add(cur.get("name"))
        chain.append(cur)
        cur = cur.get("base")

    # Emit root-first; a dict keyed by field name gives each field the ancestor-position of its
    # first declaration while a child override supplies the winning definition.
    by_name: Dict[str, FieldMetadata] = {}
    for s in reversed(chain):
        for f in s["fields"]:
            by_name[f["name"]] = f
    result = list(by_name.values())
    _fields_cache[key] = result
    return result


def all_refs(schema: SchemaMetadata) -> Dict[str, Any]:
    base = schema.get("base")
    if base is None:
        return schema.get("refs") or {}
    key = id(schema)
    memo = _refs_cache.get(key)
    if memo is not None:
        return memo

    # Walk leaf → root; a leaf entry must win, so only set a key the first time it is seen.
    merged: Dict[str, Any] = {}
    seen = set()
    cur: Optional[SchemaMetadata] = schema
    while cur is not None and cur.get("name") not in seen:
        seen.add(cur.get("name"))
        for k, v in (cur.get("refs") or {}).items():
            if k not in merged:
                merged[k] = v
        cur = cur.get("base")
    _refs_cache[key] = merged
    return merged

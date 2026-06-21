"""Test/reference utilities — port of ``@keyma/runtime-js`` ``testing.ts``.

:class:`InMemoryAdapter` is a fully in-memory :class:`KeymaDatabaseAdapter` used by
the runtime's own test suite and by adapter/plugin packages. It supports the full
Mongo-style ``where`` operator set, field/embedded/populate projections, and native
filtered counts. ``matches`` / ``matches_op`` are the standalone filter evaluators.

``brand_schema`` / ``brand_service`` attach the generated metadata statics
(``Class.schema`` / ``Class.service``) to a hand-written class — used by tests and
codegen fallback, where generated classes instead carry the statics directly.

Imported as ``from keyma.runtime.testing import InMemoryAdapter, matches, matches_op``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .types import SchemaMetadata, ServiceMetadata


class InMemoryAdapter:
    def __init__(self) -> None:
        self.stores: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self._counter = 0

    def _store_for(self, schema: SchemaMetadata) -> Dict[str, Dict[str, Any]]:
        name = schema["name"]
        s = self.stores.get(name)
        if s is None:
            s = {}
            self.stores[name] = s
        return s

    async def ensure_schema(self, schema: SchemaMetadata) -> None:
        self._store_for(schema)

    async def create(
        self, schema: SchemaMetadata, data: Dict[str, Any], projection: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        store = self._store_for(schema)
        id_ = data.get("id")
        if id_ is None:
            self._counter += 1
            id_ = f'{schema["name"]}-{self._counter}'
        record = {**data, "id": id_}
        store[id_] = record
        return self._apply_projection(record, projection) if projection is not None else record

    async def read(
        self, schema: SchemaMetadata, where: Dict[str, Any], projection: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        match = next((r for r in self._store_for(schema).values() if matches(r, where)), None)
        if match is None:
            return None
        return self._apply_projection(match, projection) if projection is not None else match

    async def list(self, schema: SchemaMetadata, query: Dict[str, Any]) -> List[Dict[str, Any]]:
        results = [r for r in self._store_for(schema).values() if matches(r, query.get("where") or {})]
        if query.get("skip") is not None:
            results = results[query["skip"]:]
        if query.get("limit") is not None:
            results = results[: query["limit"]]
        projection = query.get("projection")
        if projection is not None:
            results = [self._apply_projection(r, projection) for r in results]
        return results

    async def update(
        self,
        schema: SchemaMetadata,
        where: Dict[str, Any],
        data: Dict[str, Any],
        projection: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        store = self._store_for(schema)
        for id_, r in list(store.items()):
            if matches(r, where):
                updated = {**r, **data, "id": id_}
                store[id_] = updated
                return self._apply_projection(updated, projection) if projection is not None else updated
        # No existing record matched. When the filter targets a concrete id, upsert
        # under it (insert-or-merge); otherwise the update is undefined.
        if isinstance(where.get("id"), str):
            id_ = where["id"]
            updated = {**data, "id": id_}
            store[id_] = updated
            return self._apply_projection(updated, projection) if projection is not None else updated
        raise Exception(f"No record matches where {where!r}")

    async def delete(self, schema: SchemaMetadata, where: Dict[str, Any]) -> None:
        store = self._store_for(schema)
        for id_, r in list(store.items()):
            if matches(r, where):
                del store[id_]
                return

    async def count(self, schema: SchemaMetadata, where: Optional[Dict[str, Any]] = None) -> int:
        return sum(1 for r in self._store_for(schema).values() if matches(r, where or {}))

    def _apply_projection(self, record: Dict[str, Any], projection: Dict[str, Any]) -> Dict[str, Any]:
        if projection.get("fields") is None and projection.get("populate") is None:
            return record
        result: Dict[str, Any] = {}
        for key, spec in (projection.get("fields") or {}).items():
            if spec == 1:
                result[key] = record.get(key)
            else:
                value = record.get(key)
                result[key] = self._apply_embedded_spec(value, spec) if isinstance(value, dict) else None
        for field, node in (projection.get("populate") or {}).items():
            value = record.get(field)
            if not isinstance(value, str):
                result[field] = None
                continue
            referenced = self._store_for(node["schema"]).get(value)
            if referenced is None:
                result[field] = None
            elif node.get("projection") is not None:
                result[field] = self._apply_projection(referenced, node["projection"])
            else:
                result[field] = referenced
        return result

    def _apply_embedded_spec(self, value: Dict[str, Any], spec: Dict[str, Any]) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        for key, sub in spec.items():
            if sub == 1:
                result[key] = value.get(key)
            else:
                nested = value.get(key)
                result[key] = self._apply_embedded_spec(nested, sub) if isinstance(nested, dict) else None
        return result


def _js_strict_eq(a: Any, b: Any) -> bool:
    """Mirror JS ``===``: bool is not a number, and objects/lists compare by
    identity (never structurally)."""
    if isinstance(a, bool) != isinstance(b, bool):
        return False
    if isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
        return a is b
    return a == b


def _same_value_zero(a: Any, b: Any) -> bool:
    """Mirror JS ``Array.prototype.includes`` (SameValueZero): no bool/int
    coercion, objects/lists by identity, ``NaN`` equals ``NaN``."""
    if isinstance(a, bool) != isinstance(b, bool):
        return False
    if isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
        return a is b
    if isinstance(a, float) and isinstance(b, float) and a != a and b != b:
        return True
    return a == b


def matches(record: Dict[str, Any], where: Dict[str, Any]) -> bool:
    """Evaluate a Mongo-style ``where`` filter against a record."""
    for key, spec in where.items():
        if key == "$and":
            if not isinstance(spec, list):
                return False
            for sub in spec:
                if not matches(record, sub):
                    return False
            continue
        if key == "$or":
            if not isinstance(spec, list):
                return False
            if not any(matches(record, s) for s in spec):
                return False
            continue
        if key == "$nor":
            if not isinstance(spec, list):
                return False
            if any(matches(record, s) for s in spec):
                return False
            continue
        field_value = record.get(key)
        if isinstance(spec, dict):
            op_entries = list(spec.items())
            is_op_expr = len(op_entries) > 0 and all(k.startswith("$") for k, _ in op_entries)
            if is_op_expr:
                if not all(matches_op(field_value, op, arg) for op, arg in op_entries):
                    return False
                continue
        # JS uses strict `!==` here: object/array specs never match by structure,
        # and bool is distinct from int.
        if not _js_strict_eq(field_value, spec):
            return False
    return True


def matches_op(value: Any, op: str, arg: Any) -> bool:
    """Evaluate a single Mongo-style comparison operator (JS strict semantics)."""
    if op == "$eq":
        return _js_strict_eq(value, arg)
    if op == "$ne":
        return not _js_strict_eq(value, arg)
    if op == "$in":
        return isinstance(arg, list) and any(_same_value_zero(value, x) for x in arg)
    if op == "$nin":
        return isinstance(arg, list) and not any(_same_value_zero(value, x) for x in arg)
    # Ordered comparisons: JS coerces a missing field to NaN (every comparison
    # false → record excluded). Python would raise on None, so guard explicitly.
    if op == "$gt":
        return value is not None and arg is not None and value > arg
    if op == "$gte":
        return value is not None and arg is not None and value >= arg
    if op == "$lt":
        return value is not None and arg is not None and value < arg
    if op == "$lte":
        return value is not None and arg is not None and value <= arg
    return False


# ── Metadata branding (tests / codegen fallback) ──────────────────────────────
#
# Attach the generated metadata statics (``Class.schema`` / ``Class.service``) to a
# hand-written class. Generated classes carry these directly; test classes brand
# them on after the fact.


def brand_schema(cls: Any, schema: SchemaMetadata) -> Any:
    """Brand a plain class with :class:`SchemaMetadata` (as ``cls.schema``)."""
    cls.schema = schema
    return cls


def brand_service(cls: Any, service: ServiceMetadata) -> Any:
    """Brand a plain class with :class:`ServiceMetadata` (as ``cls.service``)."""
    cls.service = service
    return cls

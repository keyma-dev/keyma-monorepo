"""Field defaults driver — mirrors ``@keyma/runtime`` ``defaults.test.ts``.

Literal defaults ride in the field metadata and are filled generically; expression defaults are
applied by each schema's own ``applyDefaults`` callable (re-emitted onto the metadata), walked
PARENT-FIRST across the inheritance chain. Only absent keys are filled.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List

from keyma.runtime import apply_defaults

Metadata = Dict[str, Any]

base_fields: List[Dict[str, Any]] = [
    {"name": "id", "type": {"kind": "id"}},
    {"name": "status", "type": {"kind": "string"}, "default": {"kind": "literal", "value": "active"}},
    {"name": "tags", "type": {"kind": "array", "of": {"kind": "string"}}, "default": {"kind": "literal", "value": []}},
    {"name": "createdOn", "type": {"kind": "dateTime"}, "default": {"kind": "expression", "expression": {}}},
    {"name": "title", "type": {"kind": "string"}},
]


def _apply_created_on(value: Dict[str, Any]) -> None:
    if value.get("createdOn") is None:
        value["createdOn"] = datetime.now()


def make_schema() -> Metadata:
    return {"name": "thing", "sourceName": "Thing", "fields": base_fields, "applyDefaults": _apply_created_on}


schema_no_expr_defaults: Metadata = {"name": "thing", "sourceName": "Thing", "fields": base_fields}


def test_fills_absent_literal_defaults_and_runs_apply_defaults():
    data: Dict[str, Any] = {"id": "1"}
    apply_defaults(make_schema(), data)
    assert data["status"] == "active"
    assert data["tags"] == []
    assert isinstance(data["createdOn"], datetime)


def test_does_not_override_provided_values():
    provided = datetime(1970, 1, 1)
    data: Dict[str, Any] = {"id": "1", "status": "archived", "createdOn": provided}
    apply_defaults(make_schema(), data)
    assert data["status"] == "archived"
    assert data["createdOn"] is provided


def test_applies_only_literal_defaults_when_no_apply_defaults():
    data: Dict[str, Any] = {"id": "1"}
    apply_defaults(schema_no_expr_defaults, data)
    assert data["status"] == "active"
    assert "createdOn" not in data


def test_clones_array_literal_defaults_so_instances_dont_share_state():
    a: Dict[str, Any] = {"id": "1"}
    b: Dict[str, Any] = {"id": "2"}
    apply_defaults(make_schema(), a)
    apply_defaults(make_schema(), b)
    a["tags"].append("x")
    assert b["tags"] == []


def test_leaves_fields_without_a_default_untouched():
    data: Dict[str, Any] = {"id": "1"}
    apply_defaults(make_schema(), data)
    assert "title" not in data


def test_inherited_literal_defaults_and_parent_first_apply_defaults_order():
    order: List[str] = []
    base: Metadata = {
        "name": "base",
        "sourceName": "Base",
        "fields": [{"name": "kind", "type": {"kind": "string"}, "default": {"kind": "literal", "value": "node"}}],
        "applyDefaults": lambda data: order.append("base"),
    }
    leaf: Metadata = {
        "name": "leaf",
        "sourceName": "Leaf",
        "base": base,
        "fields": [{"name": "status", "type": {"kind": "string"}, "default": {"kind": "literal", "value": "active"}}],
        "applyDefaults": lambda data: order.append("leaf"),
    }
    data: Dict[str, Any] = {}
    apply_defaults(leaf, data)
    assert data["kind"] == "node"
    assert data["status"] == "active"
    assert order == ["base", "leaf"]

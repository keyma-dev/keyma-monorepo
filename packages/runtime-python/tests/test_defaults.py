"""Port of ``@keyma/runtime-js`` ``test/defaults.test.ts``.

``apply_defaults`` is attached directly to the (re-emitted) metadata, filling absent
expression-default fields. Literal defaults ride in the field metadata and are applied
generically by the runtime.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List

from keyma.runtime import apply_defaults


BASE_FIELDS: List[Dict[str, Any]] = [
    {"name": "id", "type": {"kind": "id"}},
    {"name": "status", "type": {"kind": "string"}, "default": {"kind": "literal", "value": "active"}},
    {
        "name": "tags",
        "type": {"kind": "array", "of": {"kind": "string"}},
        "default": {"kind": "literal", "value": []},
    },
    {"name": "createdOn", "type": {"kind": "dateTime"}, "default": {"kind": "expression", "expression": {}}},
    {"name": "title", "type": {"kind": "string"}},
]


def _apply_defaults(value: Dict[str, Any]) -> None:
    if value.get("createdOn") is None:
        value["createdOn"] = datetime.now(timezone.utc)


SCHEMA: Dict[str, Any] = {
    "name": "thing",
    "sourceName": "Thing",
    "fields": BASE_FIELDS,
    "applyDefaults": _apply_defaults,
}

SCHEMA_NO_EXPR_DEFAULTS: Dict[str, Any] = {"name": "thing", "sourceName": "Thing", "fields": BASE_FIELDS}


# ── applyDefaults ────────────────────────────────────────────────────────────


def test_fills_absent_keys_with_literal_defaults_and_runs_the_schemas_apply_defaults():
    data: Dict[str, Any] = {"id": "1"}
    apply_defaults(SCHEMA, data)
    assert data["status"] == "active"
    assert data["tags"] == []
    assert isinstance(data["createdOn"], datetime)


def test_does_not_override_provided_values_literal_or_expression():
    provided = datetime.fromtimestamp(0, tz=timezone.utc)
    data: Dict[str, Any] = {"id": "1", "status": "archived", "createdOn": provided}
    apply_defaults(SCHEMA, data)
    assert data["status"] == "archived"
    assert data["createdOn"] == provided


def test_applies_only_literal_defaults_when_the_schema_has_no_apply_defaults():
    data: Dict[str, Any] = {"id": "1"}
    apply_defaults(SCHEMA_NO_EXPR_DEFAULTS, data)
    assert data["status"] == "active"
    assert ("createdOn" in data) is False


def test_clones_array_literal_defaults_so_instances_dont_share_state():
    a: Dict[str, Any] = {"id": "1"}
    b: Dict[str, Any] = {"id": "2"}
    apply_defaults(SCHEMA, a)
    apply_defaults(SCHEMA, b)
    a["tags"].append("x")
    assert b["tags"] == []


def test_leaves_fields_without_a_default_untouched():
    data: Dict[str, Any] = {"id": "1"}
    apply_defaults(SCHEMA, data)
    assert ("title" in data) is False

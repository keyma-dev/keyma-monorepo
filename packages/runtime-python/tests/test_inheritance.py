"""Real-inheritance runtime behavior — Python mirror of ``@keyma/runtime-js``
``test/inheritance.test.ts``.

Schema metadata carries OWN fields only plus a ``base`` pointer; the runtime assembles the
full field/ref set by walking the chain (``all_fields``/``all_refs``). These tests lock in that
serialize/deserialize/binary/validate/apply_defaults all see inherited fields, that
private/ephemeral filtering still applies across the chain, that inherited reference targets
hydrate, and that a child field override wins over the inherited one.
"""

from __future__ import annotations

from typing import Any, Dict

from keyma.runtime.fields import all_fields, all_refs
from keyma.runtime.serialize import serialize
from keyma.runtime.deserialize import deserialize
from keyma.runtime.binary import encode_binary, decode_binary
from keyma.runtime.validate import validate
from keyma.runtime.defaults import apply_defaults
from keyma.runtime.testing import brand_schema


def required(value, field):
    if value is not None and value != "":
        return None
    return {"field": field, "code": "required", "message": f"{field} is required"}


# ── Department (inherited reference target) ──────────────────────────────────


class Department:
    def __init__(self, value=None):
        if value:
            for k, v in value.items():
                setattr(self, k, v)


DEPARTMENT_SCHEMA: Dict[str, Any] = {
    "name": "department",
    "sourceName": "Department",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "tag": 1, "readonly": True},
        {"name": "name", "type": {"kind": "string"}, "tag": 2},
    ],
}
brand_schema(Department, DEPARTMENT_SCHEMA)


# ── Person (base) ────────────────────────────────────────────────────────────


def _person_apply_defaults(data: Dict[str, Any]) -> None:
    if data.get("kind") is None:
        data["kind"] = "person"


PERSON_SCHEMA: Dict[str, Any] = {
    "name": "person",
    "sourceName": "Person",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "tag": 1, "readonly": True, "validators": [required]},
        {"name": "name", "type": {"kind": "string"}, "tag": 2, "validators": [required]},
        {"name": "ssn", "type": {"kind": "string"}, "tag": 3, "visibility": "private", "required": False},
        {"name": "active", "type": {"kind": "boolean"}, "tag": 4, "required": False, "default": {"kind": "literal", "value": True}},
    ],
    "applyDefaults": _person_apply_defaults,
}


# ── Employee extends Person ──────────────────────────────────────────────────


EMPLOYEE_SCHEMA: Dict[str, Any] = {
    "name": "employee",
    "sourceName": "Employee",
    "base": PERSON_SCHEMA,
    "fields": [
        {"name": "department", "type": {"kind": "reference", "schema": "department", "idType": {"kind": "id"}}, "tag": 5, "required": False},
        {"name": "salary", "type": {"kind": "integer"}, "tag": 6, "required": False},
    ],
    "refs": {"department": Department},
}


# ── all_fields / all_refs ─────────────────────────────────────────────────────


def test_all_fields_returns_own_plus_inherited_parent_first_with_chain_unique_tags():
    fields = all_fields(EMPLOYEE_SCHEMA)
    assert [f["name"] for f in fields] == ["id", "name", "ssn", "active", "department", "salary"]
    assert [f["tag"] for f in fields] == [1, 2, 3, 4, 5, 6]


def test_root_schema_all_fields_is_its_own_fields():
    assert [f["name"] for f in all_fields(PERSON_SCHEMA)] == ["id", "name", "ssn", "active"]


def test_all_refs_resolves_an_inherited_target_reference_declared_on_the_child():
    assert all_refs(EMPLOYEE_SCHEMA).get("department") is Department


# ── serialize / deserialize ───────────────────────────────────────────────────

_RECORD = {"id": "e1", "name": "Ada", "ssn": "secret", "active": True, "department": {"id": "d1", "name": "R&D"}, "salary": 100}


def test_client_serialize_keeps_inherited_public_and_strips_inherited_private():
    out = serialize(EMPLOYEE_SCHEMA, _RECORD, target="client")
    assert out["id"] == "e1"
    assert out["name"] == "Ada"
    assert out["salary"] == 100
    assert "ssn" not in out


def test_server_serialize_keeps_the_inherited_private_field():
    out = serialize(EMPLOYEE_SCHEMA, _RECORD, target="server")
    assert out["ssn"] == "secret"


def test_deserialize_hydrates_an_inherited_target_reference_into_its_class():
    hydrated = deserialize(EMPLOYEE_SCHEMA, {"id": "e1", "name": "Ada", "department": "d1", "salary": 100})
    assert isinstance(hydrated["department"], Department)
    assert hydrated["department"].id == "d1"


# ── binary round-trip ─────────────────────────────────────────────────────────


def test_binary_round_trip_preserves_inherited_and_own_fields():
    record = {"id": "e1", "name": "Ada", "ssn": "secret", "active": False, "department": "d1", "salary": 100}
    back = decode_binary(EMPLOYEE_SCHEMA, encode_binary(EMPLOYEE_SCHEMA, record, target="server"))
    assert back["id"] == "e1"
    assert back["name"] == "Ada"
    assert back["ssn"] == "secret"
    assert back["active"] is False
    assert back["department"] == "d1"
    assert back["salary"] == 100


def test_client_binary_target_drops_the_inherited_private_field():
    record = {"id": "e1", "name": "Ada", "ssn": "secret"}
    back = decode_binary(EMPLOYEE_SCHEMA, encode_binary(EMPLOYEE_SCHEMA, record, target="client"))
    assert "ssn" not in back
    assert back["name"] == "Ada"


# ── validate ──────────────────────────────────────────────────────────────────


async def test_validate_reports_inherited_required_fields_that_are_absent():
    errors = await validate(EMPLOYEE_SCHEMA, {"salary": 100})
    assert sorted(e["field"] for e in errors) == ["id", "name"]


async def test_validate_passes_when_all_inherited_required_fields_present():
    assert await validate(EMPLOYEE_SCHEMA, {"id": "e1", "name": "Ada"}) == []


# ── apply_defaults ────────────────────────────────────────────────────────────


def test_apply_defaults_applies_inherited_literal_and_parents_expression_initializer():
    data: Dict[str, Any] = {"id": "e1", "name": "Ada"}
    apply_defaults(EMPLOYEE_SCHEMA, data)
    assert data["active"] is True
    assert data["kind"] == "person"


def test_apply_defaults_does_not_overwrite_a_provided_inherited_field():
    data: Dict[str, Any] = {"id": "e1", "name": "Ada", "active": False}
    apply_defaults(EMPLOYEE_SCHEMA, data)
    assert data["active"] is False


# ── child field override wins ─────────────────────────────────────────────────


def test_child_field_override_wins_in_ancestor_position():
    child_override: Dict[str, Any] = {
        "name": "manager",
        "sourceName": "Manager",
        "base": PERSON_SCHEMA,
        "fields": [
            {"name": "active", "type": {"kind": "boolean"}, "tag": 4, "validators": [required]},
        ],
    }
    fields = all_fields(child_override)
    assert [f["name"] for f in fields] == ["id", "name", "ssn", "active"]
    active = next(f for f in fields if f["name"] == "active")
    assert len(active.get("validators") or []) == 1

"""Contract test: the runtime must consume EXACTLY what @keyma/compiler-backend-python
emits. The fixtures here are shaped byte-for-byte like the backend's generated output
(see compiler-backend-python/src/emit-validators.ts and schema-data.ts):

- validators are factory closures returning ``def _v(raw, field): ... -> dict | None``
  (variable inner arity; type guards return a ``{"field","code","message"}`` dict);
- formatters are ``def _f(value): ...`` that ``raise TypeError`` on a type mismatch;
- schema metadata is a plain camelCase ``dict`` attached as ``Class.schema``;
- ``refs`` is a ``dict`` ``{"address": Address}``;
- getters are emitted as ``@property`` accessors on the class (behaviors, not fields);
- expression defaults are a module-level ``applyDefaults`` function on the metadata.

If the runtime's calling convention drifts from the backend's emitted shape, these break.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from keyma.runtime import (
    KeymaServer,
    apply_defaults,
    create_direct_transport,
    deserialize,
    format,
    serialize,
    validate,
)
from keyma.runtime.testing import InMemoryAdapter, brand_schema


# ── Generated-style validator factories (exact emit-validators.ts shape) ─────


def email():
    def _v(raw, field):
        if not (isinstance(raw, str)):
            return {"field": field, "code": "type_error", "message": "expected string"}
        if "@" not in raw:
            return {"field": field, "code": "email", "message": "invalid email"}
        return None

    return _v


def min_value(value):
    def _v(raw, field):
        if not (isinstance(raw, int) and not isinstance(raw, bool)):
            return {"field": field, "code": "type_error", "message": "expected integer"}
        if raw < value:
            # Backend emits some errors with no "message" key — the runtime must
            # append whatever dict the validator returns, verbatim.
            return {"field": field, "code": "min_value"}
        return None

    return _v


def matches_field(other):
    # 3-arg cross-field validator. This is exactly the shape the Python backend now
    # emits: `def _v(value, field, ctx): ... ctx.object.get("<field>") ...` (the
    # backend lowers `ctx.object.<field>` to a dict lookup since the runtime's
    # context `.object` is the record dict).
    def _v(raw, field, ctx):
        if raw != ctx.object.get(other):
            return {"field": field, "code": "mismatch", "message": f"must match {other}"}
        return None

    return _v


# ── Generated-style formatter factories (exact shape; raise TypeError) ───────


def lowercase():
    def _f(value):
        if not (isinstance(value, str)):
            raise TypeError("lowercase formatter expected string, got " + type(value).__name__)
        return value.lower()

    return _f


def trim():
    def _f(value):
        if not (isinstance(value, str)):
            raise TypeError("trim formatter expected string, got " + type(value).__name__)
        return value.strip()

    return _f


# ── Generated-style module-level applyDefaults ───────────────────────────────


def _apply_defaults_user(data: dict) -> None:
    # Expression-kind default: createdAt = now() (here a fixed value for determinism).
    if "createdAt" not in data or data["createdAt"] is None:
        data["createdAt"] = "2024-01-01T00:00:00.000Z"


# ── Generated-style model classes (Class.schema is a plain camelCase dict) ───


class Address:
    def __init__(self, value=None):
        if value:
            self.line1 = value.get("line1")
            self.city = value.get("city")


brand_schema(
    Address,
    {
        "name": "address",
        "sourceName": "Address",
        "fields": [
            {"name": "line1", "type": {"kind": "string"}},
            {"name": "city", "type": {"kind": "string"}},
        ],
    },
)


class User:
    def __init__(self, value=None):
        if value:
            self.id = value.get("id")
            self.firstName = value.get("firstName")
            self.lastName = value.get("lastName")
            self.email = value.get("email")
            self.age = value.get("age")
            self.address = value.get("address")
            self.status = value.get("status")
            self.createdAt = value.get("createdAt")

    @property
    def fullName(self) -> str:
        return str(self.firstName) + " " + str(self.lastName)


brand_schema(
    User,
    {
        "name": "user",
        "sourceName": "User",
        "fields": [
            {"name": "id", "type": {"kind": "id"}, "readonly": True},
            {
                "name": "firstName",
                "type": {"kind": "string"},
                "formatters": [{"phase": "change", "fn": trim()}],
            },
            {"name": "lastName", "type": {"kind": "string"}},
            {
                "name": "email",
                "type": {"kind": "string"},
                "validators": [email()],
                "formatters": [{"phase": "save", "fn": lowercase()}],
            },
            {"name": "age", "type": {"kind": "integer"}, "validators": [min_value(18)]},
            {"name": "address", "type": {"kind": "embedded", "schema": "address"}, "required": False},
            {"name": "status", "type": {"kind": "string"}, "required": False, "default": {"kind": "literal", "value": "active"}},
            {"name": "createdAt", "type": {"kind": "dateTime"}, "required": False},
        ],
        "refs": {"address": Address},
        "applyDefaults": _apply_defaults_user,
    },
)


# ── Validators ───────────────────────────────────────────────────────────────


async def test_runs_variable_arity_validator_closures():
    # email() and min_value() inner closures take (raw, field); the runtime passes
    # (value, field, context) truncated to arity — no TypeError on the extra arg.
    errors = await validate(User.schema, {"firstName": "A", "lastName": "B", "email": "nope", "age": 30})
    codes = {e["code"] for e in errors}
    assert "email" in codes


async def test_type_guard_returns_validation_error_dict_not_string():
    errors = await validate(User.schema, {"firstName": "A", "lastName": "B", "email": 123, "age": 30})
    type_errors = [e for e in errors if e["field"] == "email"]
    assert len(type_errors) == 1
    assert type_errors[0] == {"field": "email", "code": "type_error", "message": "expected string"}


async def test_appends_message_less_error_dict_verbatim():
    errors = await validate(User.schema, {"firstName": "A", "lastName": "B", "email": "a@b.com", "age": 5})
    age_errors = [e for e in errors if e["field"] == "age"]
    assert age_errors == [{"field": "age", "code": "min_value"}]


async def test_getter_is_not_a_field_so_not_validated():
    # `fullName` is a getter behavior, not a schema field — it never appears in
    # validation (no "required" for a value that is never part of the record).
    errors = await validate(User.schema, {"firstName": "A", "lastName": "B", "email": "a@b.com", "age": 30})
    assert all(e["field"] != "fullName" for e in errors)


async def test_three_arg_validator_reads_ctx_object_cross_field():
    schema = {
        "name": "signup",
        "sourceName": "Signup",
        "fields": [
            {"name": "password", "type": {"kind": "string"}},
            {"name": "confirm", "type": {"kind": "string"}, "validators": [matches_field("password")]},
        ],
    }
    ok = await validate(schema, {"password": "secret", "confirm": "secret"})
    assert ok == []
    bad = await validate(schema, {"password": "secret", "confirm": "typo"})
    assert bad == [{"field": "confirm", "code": "mismatch", "message": "must match password"}]


# ── Formatters ───────────────────────────────────────────────────────────────


async def test_runs_single_arity_formatter_for_matching_phase():
    value = {"firstName": "  Ada  ", "email": "ADA@EXAMPLE.COM"}
    await format(User.schema, value, "change")
    assert value["firstName"] == "Ada"  # trim ran (phase "change")
    assert value["email"] == "ADA@EXAMPLE.COM"  # lowercase did NOT run (phase "save")
    await format(User.schema, value, "save")
    assert value["email"] == "ada@example.com"  # lowercase ran now


async def test_formatter_type_guard_raises_typeerror():
    with pytest.raises(TypeError):
        await format(User.schema, {"firstName": 123}, "change")


# ── Defaults (literal + expression applyDefaults fn) ─────────────────────────


def test_apply_defaults_fills_literal_and_expression_defaults():
    data = apply_defaults(User.schema, {"firstName": "A", "lastName": "B"})
    assert data["status"] == "active"  # literal default
    assert data["createdAt"] == "2024-01-01T00:00:00.000Z"  # applyDefaults expression fn


def test_apply_defaults_does_not_override_supplied_values():
    data = apply_defaults(User.schema, {"status": "banned", "createdAt": "2020-01-01T00:00:00.000Z"})
    assert data["status"] == "banned"
    assert data["createdAt"] == "2020-01-01T00:00:00.000Z"


# ── Serialize / deserialize with dict refs & embedded class ──────────────────


def test_serialize_recurses_embedded_via_dict_refs_and_converts_datetime():
    out = serialize(
        User.schema,
        {
            "id": "u1",
            "firstName": "A",
            "lastName": "B",
            "address": {"line1": "1 St", "city": "Town"},
            "createdAt": datetime(2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc),
        },
        target="server",
    )
    assert out["address"] == {"line1": "1 St", "city": "Town"}
    assert out["createdAt"] == 1704164645000


def test_serialize_omits_getter_accessor():
    # `fullName` is a getter behavior, not a schema field, so it is NOT serialized —
    # serialize only walks `schema["fields"]`. The accessor stays on the instance.
    user = User({"id": "u1", "firstName": "Ada", "lastName": "Lovelace"})
    assert user.fullName == "Ada Lovelace"  # the accessor still works on the instance
    out = serialize(User.schema, user, target="server")
    assert "fullName" not in out


def test_deserialize_instantiates_embedded_and_parses_datetime():
    out = deserialize(
        User.schema,
        {"id": "u1", "address": {"line1": "1 St", "city": "Town"}, "createdAt": 1704164645000},
    )
    assert isinstance(out["address"], Address)
    assert out["address"].city == "Town"
    assert isinstance(out["createdAt"], datetime)
    assert out["createdAt"] == datetime(2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc)


# ── Full server round-trip over genuine backend-shaped metadata ──────────────


async def test_server_drives_generated_shaped_metadata_end_to_end():
    adapter = InMemoryAdapter()
    server = KeymaServer(schemas=[User.schema, Address.schema], adapter=adapter)
    await server.ensure_schemas()
    transport = create_direct_transport(server)

    resp = await transport(
        {
            "operations": {
                "a": {
                    "op": "create",
                    "schema": "user",
                    "data": {"firstName": "Ada", "lastName": "Lovelace", "email": "ADA@EXAMPLE.COM", "age": 36},
                }
            }
        }
    )
    a = resp["results"]["a"]
    assert a["ok"] is True
    assert a["data"]["email"] == "ada@example.com"  # save-phase lowercase ran
    assert a["data"]["status"] == "active"  # literal default applied
    assert a["data"]["createdAt"] == "2024-01-01T00:00:00.000Z"  # applyDefaults ran
    assert a["data"]["id"].startswith("user-")


async def test_server_reports_validation_failure_from_generated_validators():
    adapter = InMemoryAdapter()
    server = KeymaServer(schemas=[User.schema], adapter=adapter)
    await server.ensure_schemas()
    resp = await server.handle(
        {"operations": {"a": {"op": "create", "schema": "user", "data": {"firstName": "A", "lastName": "B", "email": "bad", "age": 5}}}}
    )
    a = resp["results"]["a"]
    assert a["ok"] is False
    assert a["code"] == "VALIDATION_FAILED"
    codes = {e["code"] for e in a["errors"]}
    assert "email" in codes and "min_value" in codes

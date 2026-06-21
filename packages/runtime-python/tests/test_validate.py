"""Port of @keyma/runtime-js test/validate.test.ts.

describe("validate — direct-ref validators").
Schemas, fields, and validators are defined inline (the JS test defined them inline).
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List

from keyma.runtime import validate


def schema(fields: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"name": "test", "sourceName": "Test", "fields": fields}


def field(name: str, validators: List[Callable]) -> Dict[str, Any]:
    return {"name": name, "type": {"kind": "string"}, "required": False, "validators": validators}


def is_even(raw, field_name):
    if isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw % 2 == 0:
        return None
    return {"field": field_name, "code": "isEven", "message": f"{field_name} must be even"}


def min_length(n):
    def _v(raw, field_name):
        if isinstance(raw, str) and len(raw) < n:
            return {"field": field_name, "code": "minLength", "message": ""}
        return None

    return _v


async def test_runs_a_validator_attached_directly_to_the_field_metadata():
    s = schema([{"name": "n", "type": {"kind": "number"}, "required": False, "validators": [is_even]}])
    errors = await validate(s, {"n": 3})
    assert len(errors) == 1
    assert errors[0]["code"] == "isEven"


async def test_a_passing_validator_yields_no_error():
    s = schema([{"name": "n", "type": {"kind": "number"}, "required": False, "validators": [is_even]}])
    assert await validate(s, {"n": 4}) == []


async def test_fields_without_validators_are_no_ops():
    s = schema([field("email", [])])
    assert await validate(s, {}) == []


async def test_a_parameterized_validator_factory_closes_over_its_params():
    s = schema([field("name", [min_length(3)])])
    errors = await validate(s, {"name": "ab"})
    assert len(errors) == 1
    assert errors[0]["code"] == "minLength"


async def test_runs_every_validator_on_a_field_accumulating_errors():
    def fail(code):
        def _v(_v_raw, f):
            return {"field": f, "code": code, "message": ""}

        return _v

    s = schema([field("x", [fail("a"), fail("b")])])
    errors = await validate(s, {"x": "v"})
    assert [e["code"] for e in errors] == ["a", "b"]


async def test_awaits_async_validators():
    async def async_fail(_v_raw, f):
        return {"field": f, "code": "async", "message": ""}

    s = schema([field("x", [async_fail])])
    errors = await validate(s, {"x": "v"})
    assert errors[0]["code"] == "async"

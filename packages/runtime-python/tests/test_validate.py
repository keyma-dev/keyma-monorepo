"""Field validation driver — mirrors ``@keyma/runtime`` ``validate.test.ts``.

Drives hand-built metadata dicts (the shape the schema backend emits into ``Class.metadata``):
own-only ``fields`` with direct-ref ``validators`` callables, inherited fields via a ``base`` link.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from keyma.runtime import validate

Metadata = Dict[str, Any]


def schema(fields: List[Dict[str, Any]]) -> Metadata:
    return {"name": "test", "sourceName": "Test", "fields": fields}


def field(name: str, validators: List[Callable[..., Any]]) -> Dict[str, Any]:
    return {"name": name, "type": {"kind": "string"}, "required": False, "validators": validators}


def is_even(raw: Any, field_name: str) -> Optional[Dict[str, Any]]:
    if isinstance(raw, int) and not isinstance(raw, bool) and raw % 2 == 0:
        return None
    return {"field": field_name, "code": "isEven", "message": f"{field_name} must be even"}


def min_length(n: int) -> Callable[..., Optional[Dict[str, Any]]]:
    def _v(raw: Any, field_name: str) -> Optional[Dict[str, Any]]:
        if isinstance(raw, str) and len(raw) < n:
            return {"field": field_name, "code": "minLength", "message": ""}
        return None

    return _v


def test_runs_a_directly_attached_validator():
    s = schema([{"name": "n", "type": {"kind": "number"}, "required": False, "validators": [is_even]}])
    errors = validate(s, {"n": 3})
    assert len(errors) == 1
    assert errors[0]["code"] == "isEven"


def test_a_passing_validator_yields_no_error():
    s = schema([{"name": "n", "type": {"kind": "number"}, "required": False, "validators": [is_even]}])
    assert validate(s, {"n": 4}) == []


def test_fields_without_validators_are_noops():
    s = schema([field("email", [])])
    assert validate(s, {}) == []


def test_parameterized_validator_factory_closes_over_its_params():
    s = schema([field("name", [min_length(3)])])
    errors = validate(s, {"name": "ab"})
    assert len(errors) == 1
    assert errors[0]["code"] == "minLength"


def test_runs_every_validator_on_a_field_accumulating_errors():
    def fail(code: str) -> Callable[..., Dict[str, Any]]:
        def _v(_raw: Any, field_name: str) -> Dict[str, Any]:
            return {"field": field_name, "code": code, "message": ""}

        return _v

    s = schema([field("x", [fail("a"), fail("b")])])
    errors = validate(s, {"x": "v"})
    assert [e["code"] for e in errors] == ["a", "b"]


def test_a_missing_required_field_fails_with_code_required():
    s = schema([{"name": "id", "type": {"kind": "id"}}])
    errors = validate(s, {})
    assert len(errors) == 1
    assert errors[0]["code"] == "required"
    assert errors[0]["field"] == "id"


def test_a_missing_optional_field_is_skipped():
    s = schema([field("nickname", [min_length(3)])])
    assert validate(s, {}) == []


def test_validates_inherited_fields_by_walking_the_base_chain():
    base = {"name": "base", "sourceName": "Base", "fields": [field("name", [min_length(3)])]}
    leaf = {"name": "leaf", "sourceName": "Leaf", "base": base, "fields": [field("nick", [min_length(2)])]}
    errors = validate(leaf, {"name": "ab", "nick": "x"})
    assert [e["code"] for e in errors] == ["minLength", "minLength"]
    assert [e["field"] for e in errors] == ["name", "nick"]

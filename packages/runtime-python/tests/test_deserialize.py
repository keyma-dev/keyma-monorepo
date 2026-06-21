"""Port of ``@keyma/runtime-js`` ``test/deserialize.test.ts``.

describe("deserialize") group. Uses inline mini-schemas (Inner / Ref / Outer)
branded via ``brand_schema`` rather than the shared fixtures.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from keyma.runtime import brand_schema, deserialize
from keyma.runtime._iso import to_iso


# ─── Reusable mini-schemas ───────────────────────────────────────────────────


class InnerCtor:
    def __init__(self, value: Optional[Dict[str, Any]] = None) -> None:
        if value:
            for k, v in value.items():
                setattr(self, k, v)


INNER_SCHEMA: Dict[str, Any] = {
    "name": "inner",
    "sourceName": "Inner",
    "fields": [
        {"name": "label", "type": {"kind": "string"}},
        {"name": "when", "type": {"kind": "dateTime"}, "required": False},
    ],
}

Inner = brand_schema(InnerCtor, INNER_SCHEMA)


class RefCtor:
    def __init__(self, value: Optional[Dict[str, Any]] = None) -> None:
        if value:
            for k, v in value.items():
                setattr(self, k, v)


REF_SCHEMA: Dict[str, Any] = {
    "name": "ref",
    "sourceName": "Ref",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "readonly": True},
        {"name": "label", "type": {"kind": "string"}},
    ],
}

Ref = brand_schema(RefCtor, REF_SCHEMA)


def with_refs(fields: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "name": "outer",
        "sourceName": "Outer",
        "fields": fields,
        "refs": {"inner": Inner, "ref": Ref},
    }


# ─── Tests ───────────────────────────────────────────────────────────────────


def test_converts_date_time_iso_strings_to_date():
    schema = with_refs([{"name": "when", "type": {"kind": "dateTime"}}])
    iso = "2024-01-02T03:04:05.000Z"
    out = deserialize(schema, {"when": iso})
    assert isinstance(out["when"], datetime)
    assert to_iso(out["when"]) == iso


def test_passes_null_undefined_through_a_nullable_date_time():
    schema = with_refs(
        [
            {
                "name": "when",
                "type": {"kind": "dateTime"},
                "nullable": True,
                "required": False,
            }
        ]
    )
    assert deserialize(schema, {"when": None})["when"] is None
    # JS `undefined` -> Python None; the key is present with value None.
    assert deserialize(schema, {"when": None})["when"] is None


def test_converts_every_element_in_an_array_of_date_time():
    schema = with_refs(
        [{"name": "stamps", "type": {"kind": "array", "of": {"kind": "dateTime"}}}]
    )
    out = deserialize(
        schema,
        {"stamps": ["2024-01-01T00:00:00.000Z", "2024-02-02T00:00:00.000Z"]},
    )
    stamps = out["stamps"]
    assert isinstance(stamps[0], datetime)
    assert isinstance(stamps[1], datetime)


def test_instantiates_embedded_subobjects_via_refs_and_recurses_into_them():
    schema = with_refs(
        [{"name": "inner", "type": {"kind": "embedded", "schema": "inner"}}]
    )
    out = deserialize(
        schema,
        {"inner": {"label": "hi", "when": "2024-01-02T03:04:05.000Z"}},
    )
    assert isinstance(out["inner"], Inner)
    inner = out["inner"]
    assert inner.label == "hi"
    assert isinstance(inner.when, datetime)


def test_constructs_a_stub_reference_instance_from_a_bare_id_string():
    schema = with_refs(
        [{"name": "ref", "type": {"kind": "reference", "schema": "ref"}}]
    )
    out = deserialize(schema, {"ref": "r1"})
    assert isinstance(out["ref"], Ref)
    ref = out["ref"]
    assert ref.id == "r1"
    assert getattr(ref, "label", None) is None


def test_fully_constructs_a_populated_reference_object():
    schema = with_refs(
        [{"name": "ref", "type": {"kind": "reference", "schema": "ref"}}]
    )
    out = deserialize(schema, {"ref": {"id": "r1", "label": "hello"}})
    assert isinstance(out["ref"], Ref)
    ref = out["ref"]
    assert ref.id == "r1"
    assert ref.label == "hello"


def test_leaves_values_untouched_when_refs_map_is_absent():
    schema = {
        "name": "outer",
        "sourceName": "Outer",
        "fields": [
            {"name": "inner", "type": {"kind": "embedded", "schema": "inner"}},
            {"name": "ref", "type": {"kind": "reference", "schema": "ref"}},
        ],
    }
    out = deserialize(schema, {"inner": {"label": "hi"}, "ref": "r1"})
    assert out["inner"] == {"label": "hi"}
    assert out["ref"] == "r1"


def test_omits_fields_missing_from_input_rather_than_setting_them_to_undefined():
    schema = with_refs(
        [
            {"name": "label", "type": {"kind": "string"}},
            {"name": "when", "type": {"kind": "dateTime"}, "required": False},
        ]
    )
    out = deserialize(schema, {"label": "only"})
    assert list(out.keys()) == ["label"]
    assert "when" not in out

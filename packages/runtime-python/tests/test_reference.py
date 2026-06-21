"""Port of ``@keyma/runtime-js`` ``test/reference.test.ts`` — unit tests for the
reference-id normalization helpers."""

from __future__ import annotations

from keyma.runtime.reference import (
    core_field_type,
    normalize_reference_field_value,
    normalize_reference_ids,
    normalize_reference_value,
)

from fixtures import USER_SCHEMA, Organization


# ── normalize_reference_value ─────────────────────────────────────────────────


def test_passes_a_bare_id_through():
    assert normalize_reference_value("o1") == "o1"


def test_collapses_an_id_dict_to_the_bare_id():
    assert normalize_reference_value({"id": "o1"}) == "o1"


def test_collapses_a_full_model_instance_to_its_id():
    org = Organization({"id": "o1", "name": "Acme", "tier": "pro"})
    assert normalize_reference_value(org) == "o1"


def test_passes_none_through():
    assert normalize_reference_value(None) is None


def test_passes_a_non_dict_primitive_through():
    assert normalize_reference_value(42) == 42


def test_leaves_a_dict_without_an_id_alone():
    v = {"name": "Acme"}
    assert normalize_reference_value(v) is v


# ── normalize_reference_field_value ───────────────────────────────────────────


def test_normalizes_scalar_operator_operands():
    assert normalize_reference_field_value({"$eq": {"id": "o1"}}) == {"$eq": "o1"}
    assert normalize_reference_field_value({"$ne": "o1"}) == {"$ne": "o1"}


def test_normalizes_array_operator_operands_element_wise():
    assert normalize_reference_field_value({"$in": [{"id": "o1"}, "o2"]}) == {"$in": ["o1", "o2"]}


def test_preserves_operator_objects_already_holding_bare_ids():
    assert normalize_reference_field_value({"$in": ["o1", "o2"]}) == {"$in": ["o1", "o2"]}


def test_normalizes_a_bare_list_of_references_element_wise():
    assert normalize_reference_field_value([{"id": "a"}, "b"]) == ["a", "b"]


def test_collapses_a_scalar_reference_value():
    assert normalize_reference_field_value({"id": "o1"}) == "o1"


# ── normalize_reference_ids ───────────────────────────────────────────────────


def test_collapses_references_leaves_embedded_and_scalars_untouched():
    address = {"line1": "1 Main", "city": "Springfield", "postalCode": "12345"}
    out = normalize_reference_ids(
        {
            "email": "a@b.com",
            "organization": {"id": "o1", "name": "Acme"},  # reference -> id
            "address": address,  # embedded -> untouched
        },
        USER_SCHEMA,
    )
    assert out["organization"] == "o1"
    assert out["address"] == address
    assert out["email"] == "a@b.com"


def test_does_not_mutate_the_input_record():
    record = {"organization": {"id": "o1"}}
    out = normalize_reference_ids(record, USER_SCHEMA)
    assert record == {"organization": {"id": "o1"}}  # unchanged
    assert out["organization"] == "o1"
    assert out is not record


def test_ignores_reference_fields_absent_from_the_record():
    out = normalize_reference_ids({"email": "a@b.com"}, USER_SCHEMA)
    assert out == {"email": "a@b.com"}
    assert "organization" not in out


# ── core_field_type ───────────────────────────────────────────────────────────


def test_unwraps_array_element_types():
    assert core_field_type({"kind": "array", "of": {"kind": "reference", "schema": "x"}}) == {
        "kind": "reference",
        "schema": "x",
    }


def test_returns_scalar_types_unchanged():
    assert core_field_type({"kind": "string"}) == {"kind": "string"}

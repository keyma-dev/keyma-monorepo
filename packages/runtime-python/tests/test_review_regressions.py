"""Regression tests for behavioral-divergence fixes found by the TS-vs-Python
adversarial review. Each test pins a previously-untested branch where the Python
port diverged from @keyma/runtime-js and would have produced a wrong result.
"""

from __future__ import annotations

from keyma.runtime import KeymaServer, apply_defaults, create_direct_transport
from keyma.runtime.testing import InMemoryAdapter, matches, matches_op

from fixtures import USER_SCHEMA


# ── [1] result-hook fallback coalesces on the first element, not the whole list ──


class _NullingResultPlugin:
    name = "nulling"

    def transform_result(self, ctx, schema, records, action):
        # A plugin may legitimately return a list whose first element is None.
        return [None]


async def test_result_hook_returning_none_falls_back_to_record_on_create_and_read():
    adapter = InMemoryAdapter()
    server = KeymaServer(schemas=[USER_SCHEMA], adapter=adapter, plugins=[_NullingResultPlugin()])
    await server.ensure_schemas()

    created = await server.handle(
        {"operations": {"a": {"op": "create", "schema": "user", "data": {"email": "a@b.com", "name": "Al"}}}}
    )
    a = created["results"]["a"]
    assert a["ok"] is True
    assert a["data"] is not None  # falls back to the created record, not None
    assert a["data"]["email"] == "a@b.com"

    read = await server.handle({"operations": {"r": {"op": "read", "schema": "user", "where": {"id": a["data"]["id"]}}}})
    r = read["results"]["r"]
    assert r["ok"] is True
    assert r["data"] is not None


# ── [5] ordered operators must not crash on a missing/None field ─────────────


def test_ordered_ops_exclude_missing_field_instead_of_crashing():
    # JS coerces a missing field to NaN (comparison false → excluded); Python must
    # not raise TypeError on None.
    assert matches({"id": "x"}, {"age": {"$gt": 18}}) is False
    assert matches({"id": "x", "age": None}, {"age": {"$lte": 18}}) is False
    assert matches_op(None, "$gt", 5) is False
    assert matches_op(20, "$gt", None) is False
    # Present numeric value still compares normally.
    assert matches({"age": 20}, {"age": {"$gte": 18}}) is True


async def test_count_with_gt_filter_over_records_missing_the_field():
    adapter = InMemoryAdapter()
    server = KeymaServer(schemas=[USER_SCHEMA], adapter=adapter)
    await server.ensure_schemas()
    await adapter.create(USER_SCHEMA, {"id": "u1", "email": "a@b.com", "name": "A"})  # no "age" field
    resp = await server.handle({"operations": {"n": {"op": "count", "schema": "user", "where": {"age": {"$gt": 1}}}}})
    assert resp["results"]["n"] == {"ok": True, "data": 0}


# ── [6] bare equality uses JS strict ===, not Python deep/bool-coercing == ────


def test_bare_equality_is_strict():
    # Object/array specs never match structurally (JS reference equality).
    assert matches({"a": {"x": 1}}, {"a": {"x": 1}}) is False
    # bool is distinct from int.
    assert matches({"flag": 1}, {"flag": True}) is False
    assert matches({"flag": True}, {"flag": True}) is True
    # Scalars still match by value.
    assert matches({"n": 5, "s": "hi"}, {"n": 5, "s": "hi"}) is True


# ── [7] $eq / $ne use strict equality ────────────────────────────────────────


def test_eq_ne_are_strict():
    assert matches_op(1, "$eq", True) is False
    assert matches_op(1, "$ne", True) is True
    assert matches_op([1, 2], "$eq", [1, 2]) is False  # identity, not structure
    assert matches_op("a", "$eq", "a") is True
    assert matches_op("a", "$ne", "b") is True


# ── [8] $in / $nin use SameValueZero (no bool/int coercion) ──────────────────


def test_in_nin_same_value_zero():
    assert matches_op(1, "$in", [True]) is False
    assert matches_op(1, "$in", [1, 2, 3]) is True
    assert matches_op(2, "$nin", [1, 3]) is True
    assert matches_op(True, "$in", [True]) is True


# ── [10] apply_defaults preserves an explicitly-provided None ────────────────


def test_apply_defaults_preserves_explicit_none():
    schema = {
        "name": "x",
        "sourceName": "X",
        "fields": [
            {"name": "status", "type": {"kind": "string"}, "required": False, "default": {"kind": "literal", "value": "active"}},
            {"name": "tags", "type": {"kind": "array", "of": {"kind": "string"}}, "required": False, "default": {"kind": "literal", "value": []}},
        ],
    }
    # Absent key -> default applied.
    assert apply_defaults(schema, {})["status"] == "active"
    # Explicitly-provided None is a value -> default NOT applied (matches JS).
    assert apply_defaults(schema, {"status": None})["status"] is None
    assert apply_defaults(schema, {"tags": None})["tags"] is None

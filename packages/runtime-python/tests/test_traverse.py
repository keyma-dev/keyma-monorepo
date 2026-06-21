"""Port of ``@keyma/runtime-js`` ``test/traverse.test.ts``.

Covers ``Keyma.traverse`` leaf shape, query request-time options/substitution,
and ``KeymaServer`` traverse dispatch. The TS file also contains compile-time
type-narrowing assertions; only the runtime-observable assertions are ported.
"""

from __future__ import annotations

from typing import Any, Dict

import pytest

from keyma.runtime import Keyma, Input, KeymaServer

from fixtures import (
    Person,
    Company,
    Knows,
    WorksAt,
    PERSON_SCHEMA,
    COMPANY_SCHEMA,
    KNOWS_SCHEMA,
    WORKS_AT_SCHEMA,
    PRIVATE_EDGE_SCHEMA,
    SECRET_SCHEMA,
)


# ─── Leaf shape ──────────────────────────────────────────────────────────────


def test_heterogeneous_chain_terminal_class_is_cls_start_schema_is_independent():
    leaf = Keyma.traverse(
        Company,
        {
            "start": {"schema": Person, "where": {"id": "p1"}},
            "steps": [
                {"via": Knows, "direction": "out"},
                {"via": WorksAt, "direction": "out"},
            ],
            "emit": "nodes",
        },
    )
    assert leaf.op == "traverse"
    assert leaf.schema_class is Company
    assert leaf.spec["start"]["schema"] == "person"
    assert leaf.spec["start"]["where"] == {"id": "p1"}
    assert len(leaf.spec["steps"]) == 2
    assert leaf.spec["steps"][0]["via"] == "knows"
    assert leaf.spec["steps"][1]["via"] == "worksat"
    assert leaf.spec["emit"] == "nodes"


def test_homogeneous_repeat_cls_is_start_and_terminal():
    leaf = Keyma.traverse(
        Person,
        {
            "start": {"schema": Person, "where": {"id": "p1"}},
            "repeat": {"via": Knows, "direction": "out"},
            "depth": {"min": 1, "max": 3},
            "emit": "nodes",
        },
    )
    assert leaf.op == "traverse"
    assert leaf.schema_class is Person
    assert leaf.spec["repeat"]["via"] == "knows"
    assert leaf.spec["depth"] == {"min": 1, "max": 3}


def test_project_is_undefined_when_omitted():
    leaf = Keyma.traverse(
        Company,
        {
            "start": {"schema": Person, "where": {"id": "p1"}},
            "steps": [
                {"via": Knows, "direction": "out"},
                {"via": WorksAt, "direction": "out"},
            ],
        },
    )
    assert leaf.project is None


def test_heterogeneous_chain_stores_projection_against_terminal_schema():
    leaf = Keyma.traverse(
        Company,
        {
            "start": {"schema": Person, "where": {"id": "p1"}},
            "steps": [
                {"via": Knows, "direction": "out"},
                {"via": WorksAt, "direction": "out"},
            ],
            "project": {"id": 1, "name": 1},
        },
    )
    assert leaf.project == {"id": 1, "name": 1}


def test_homogeneous_repeat_stores_projection():
    leaf = Keyma.traverse(
        Person,
        {
            "start": {"schema": Person, "where": {"id": "p1"}},
            "repeat": {"via": Knows, "direction": "out"},
            "depth": {"max": 2},
            "project": {"id": 1, "name": 1},
        },
    )
    assert leaf.project == {"id": 1, "name": 1}


def test_emit_defaults_to_nodes_when_omitted():
    leaf = Keyma.traverse(
        Person,
        {
            "start": {"schema": Person, "where": {"id": "p1"}},
            "repeat": {"via": Knows, "direction": "out"},
            "depth": {"max": 2},
        },
    )
    assert leaf.spec["emit"] == "nodes"


def test_stores_input_placeholders_in_start_where_and_edge_edge_where():
    leaf = Keyma.traverse(
        Company,
        {
            "start": {"schema": Person, "where": {"id": Keyma.input("startId")}},
            "steps": [
                {"via": Knows, "direction": "out", "edgeWhere": {"since": Keyma.input("after")}},
                {"via": WorksAt, "direction": "out"},
            ],
            "emit": "nodes",
        },
    )
    start_id = leaf.spec["start"]["where"]["id"]
    assert isinstance(start_id, Input)
    assert start_id.name == "startId"
    since = leaf.spec["steps"][0]["edgeWhere"]["since"]
    assert isinstance(since, Input)


def test_stores_node_where_on_steps_in_the_leaf_spec():
    leaf = Keyma.traverse(
        Company,
        {
            "start": {"schema": Person, "where": {"id": "p1"}},
            "steps": [
                {"via": Knows, "direction": "out", "nodeWhere": {"name": "Alice"}},
                {"via": WorksAt, "direction": "out", "nodeWhere": {"name": "Acme"}},
            ],
            "emit": "nodes",
        },
    )
    assert leaf.spec["steps"][0]["nodeWhere"] == {"name": "Alice"}
    assert leaf.spec["steps"][1]["nodeWhere"] == {"name": "Acme"}


# ─── Keyma.query — traverse request options ──────────────────────────────────


async def test_threads_skip_limit_sort_from_request_into_spec_options_on_the_wire():
    captured: list = []

    async def transport(req):
        captured.append(req)
        return {"results": {}}

    q = Keyma.query(
        {
            "friends": Keyma.traverse(
                Person,
                {
                    "start": {"schema": Person, "where": {"id": "p1"}},
                    "repeat": {"via": Knows, "direction": "out"},
                    "depth": {"max": 3},
                    "emit": "nodes",
                },
            ),
        }
    )

    await q.request(
        {"friends": {"skip": 5, "limit": 10, "sort": {"name": 1}}},
        inputs={},
        transport=transport,
    )

    req = captured[0]
    op = req["operations"]["friends"]
    assert op["spec"]["options"] == {"skip": 5, "limit": 10, "sort": {"name": 1}}


async def test_omits_spec_options_when_no_leaf_options_are_supplied():
    captured: list = []

    async def transport(req):
        captured.append(req)
        return {"results": {}}

    q = Keyma.query(
        {
            "friends": Keyma.traverse(
                Person,
                {
                    "start": {"schema": Person, "where": {"id": "p1"}},
                    "repeat": {"via": Knows, "direction": "out"},
                    "depth": {"max": 2},
                    "emit": "nodes",
                },
            ),
        }
    )
    await q.request({}, inputs={}, transport=transport)

    req = captured[0]
    op = req["operations"]["friends"]
    assert op["spec"].get("options") is None


async def test_forwards_the_projection_onto_the_wire_operation():
    captured: list = []

    async def transport(req):
        captured.append(req)
        return {"results": {}}

    q = Keyma.query(
        {
            "companies": Keyma.traverse(
                Company,
                {
                    "start": {"schema": Person, "where": {"id": "p1"}},
                    "steps": [
                        {"via": Knows, "direction": "out"},
                        {"via": WorksAt, "direction": "out"},
                    ],
                    "project": {"id": 1, "name": 1},
                },
            ),
        }
    )
    await q.request({}, inputs={}, transport=transport)

    req = captured[0]
    op = req["operations"]["companies"]
    assert op["op"] == "traverse"
    assert op["project"] == {"id": 1, "name": 1}


# ─── Keyma.query — traverse substitution ─────────────────────────────────────


async def test_substitutes_inputs_into_the_wire_request():
    captured: list = []

    async def transport(req):
        captured.append(req)
        return {"results": {}}

    q = Keyma.query(
        {
            "colleagues": Keyma.traverse(
                Company,
                {
                    "start": {"schema": Person, "where": {"id": Keyma.input("me")}},
                    "steps": [
                        {"via": Knows, "direction": "out"},
                        {"via": WorksAt, "direction": "out"},
                    ],
                    "emit": "nodes",
                },
            ),
        }
    )

    await q.request(
        {},
        # Input name "me" -> inputs key "me" (matches Input substitution semantics).
        inputs={"colleagues": {"me": "p-123"}},
        transport=transport,
    )

    req = captured[0]
    op = req["operations"]["colleagues"]
    assert op["op"] == "traverse"
    assert op["spec"]["start"]["where"] == {"id": "p-123"}
    assert len(op["spec"]["steps"]) == 2


async def test_substitutes_input_placeholders_inside_step_node_where():
    captured: list = []

    async def transport(req):
        captured.append(req)
        return {"results": {}}

    q = Keyma.query(
        {
            "companies": Keyma.traverse(
                Company,
                {
                    "start": {"schema": Person, "where": {"id": "p1"}},
                    "steps": [
                        {"via": Knows, "direction": "out", "nodeWhere": {"name": Keyma.input("midName")}},
                        {"via": WorksAt, "direction": "out", "nodeWhere": {"name": Keyma.input("coName")}},
                    ],
                    "emit": "nodes",
                },
            ),
        }
    )

    await q.request(
        {},
        inputs={"companies": {"midName": "Alice", "coName": "Acme"}},
        transport=transport,
    )

    req = captured[0]
    op = req["operations"]["companies"]
    assert op["spec"]["steps"][0]["nodeWhere"] == {"name": "Alice"}
    assert op["spec"]["steps"][1]["nodeWhere"] == {"name": "Acme"}


# ─── Server dispatch ─────────────────────────────────────────────────────────


def make_fake_adapter(**overrides: Any) -> Any:
    """Build a fake adapter object with default no-op CRUD methods, overridable
    per-method (mirrors the JS ``makeFakeAdapter`` factory). Only the hooks set
    are present, matching ``getattr``-based dispatch."""

    async def ensure_schema(*args, **kwargs):
        return None

    async def create(*args, **kwargs):
        return {}

    async def read(*args, **kwargs):
        return None

    async def list_(*args, **kwargs):
        return []

    async def update(*args, **kwargs):
        return {}

    async def delete(*args, **kwargs):
        return None

    async def count(*args, **kwargs):
        return 0

    class _FakeAdapter:
        pass

    adapter = _FakeAdapter()
    adapter.ensure_schema = ensure_schema
    adapter.create = create
    adapter.read = read
    adapter.list = list_
    adapter.update = update
    adapter.delete = delete
    adapter.count = count
    for key, value in overrides.items():
        setattr(adapter, key, value)
    return adapter


async def test_returns_unsupported_when_adapter_has_no_traverse_method():
    server = KeymaServer(
        schemas=[PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA, WORKS_AT_SCHEMA],
        adapter=make_fake_adapter(),
    )
    resp = await server.handle(
        {
            "operations": {
                "t": {
                    "op": "traverse",
                    "schema": "company",
                    "spec": {
                        "start": {"schema": "person", "where": {"id": "p1"}},
                        "steps": [
                            {"via": "knows", "direction": "out"},
                            {"via": "worksat", "direction": "out"},
                        ],
                        "emit": "nodes",
                    },
                },
            },
        }
    )
    r = resp["results"]["t"]
    assert r["ok"] is False
    assert r["code"] == "UNSUPPORTED"


async def test_forwards_spec_to_adapter_traverse_with_resolved_context():
    received: Dict[str, Any] = {}

    async def traverse(ctx, spec, projection=None):
        received["ctx"] = ctx
        received["spec"] = spec
        return [{"id": "c1", "name": "Acme", "_company": True}]

    adapter = make_fake_adapter(traverse=traverse)
    server = KeymaServer(
        schemas=[PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA, WORKS_AT_SCHEMA],
        adapter=adapter,
    )
    resp = await server.handle(
        {
            "operations": {
                "t": {
                    "op": "traverse",
                    "schema": "company",
                    "spec": {
                        "start": {"schema": "person", "where": {"id": "p1"}},
                        "steps": [
                            {"via": "knows", "direction": "out"},
                            {"via": "worksat", "direction": "out"},
                        ],
                        "emit": "nodes",
                    },
                },
            },
        }
    )

    r = resp["results"]["t"]
    assert r["ok"] is True
    assert r["data"] == [{"id": "c1", "name": "Acme", "_company": True}]
    received_ctx = received.get("ctx")
    assert received_ctx
    assert received_ctx["terminalSchema"]["name"] == "company"
    assert received_ctx["startSchema"]["name"] == "person"
    assert "knows" in received_ctx["edges"]
    assert "worksat" in received_ctx["edges"]
    # Nodes should include start, terminal, AND any endpoint discovered from edges.
    assert "person" in received_ctx["nodes"]
    assert "company" in received_ctx["nodes"]
    assert received.get("spec")


async def test_returns_schema_not_found_when_start_schema_is_unknown():
    async def traverse(ctx, spec, projection=None):
        return []

    server = KeymaServer(
        schemas=[PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA, WORKS_AT_SCHEMA],
        adapter=make_fake_adapter(traverse=traverse),
    )
    resp = await server.handle(
        {
            "operations": {
                "t": {
                    "op": "traverse",
                    "schema": "company",
                    "spec": {
                        "start": {"schema": "ghost", "where": {}},
                        "steps": [{"via": "knows", "direction": "out"}],
                        "emit": "nodes",
                    },
                },
            },
        }
    )
    r = resp["results"]["t"]
    assert r["ok"] is False
    assert r["code"] == "SCHEMA_NOT_FOUND"


async def test_rejects_traverse_whose_start_schema_is_private_with_schema_not_found():
    async def traverse(ctx, spec, projection=None):
        return []

    server = KeymaServer(
        schemas=[PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA, WORKS_AT_SCHEMA, SECRET_SCHEMA],
        adapter=make_fake_adapter(traverse=traverse),
    )
    resp = await server.handle(
        {
            "operations": {
                "t": {
                    "op": "traverse",
                    "schema": "company",
                    "spec": {
                        "start": {"schema": "secret", "where": {}},
                        "steps": [{"via": "knows", "direction": "out"}],
                        "emit": "nodes",
                    },
                },
            },
        }
    )
    r = resp["results"]["t"]
    assert r["ok"] is False
    assert r["code"] == "SCHEMA_NOT_FOUND"


async def test_rejects_traverse_whose_edge_schema_is_private_with_schema_not_found():
    async def traverse(ctx, spec, projection=None):
        return []

    server = KeymaServer(
        schemas=[PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA, PRIVATE_EDGE_SCHEMA],
        adapter=make_fake_adapter(traverse=traverse),
    )
    resp = await server.handle(
        {
            "operations": {
                "t": {
                    "op": "traverse",
                    "schema": "person",
                    "spec": {
                        "start": {"schema": "person", "where": {"id": "p1"}},
                        "steps": [{"via": "privateEdge", "direction": "out"}],
                        "emit": "nodes",
                    },
                },
            },
        }
    )
    r = resp["results"]["t"]
    assert r["ok"] is False
    assert r["code"] == "SCHEMA_NOT_FOUND"


async def test_system_identity_bypasses_visibility_guard_on_traverse():
    called = {"value": False}

    async def traverse(ctx, spec, projection=None):
        called["value"] = True
        return []

    server = KeymaServer(
        schemas=[PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA, PRIVATE_EDGE_SCHEMA],
        adapter=make_fake_adapter(traverse=traverse),
    )
    resp = await server.handle(
        {
            "operations": {
                "t": {
                    "op": "traverse",
                    "schema": "person",
                    "spec": {
                        "start": {"schema": "person", "where": {"id": "p1"}},
                        "steps": [{"via": "privateEdge", "direction": "out"}],
                        "emit": "nodes",
                    },
                },
            },
        },
        {"identity": {"isSystem": True}},
    )
    r = resp["results"]["t"]
    assert r["ok"] is True
    assert called["value"] is True


async def test_returns_not_an_edge_when_a_step_references_a_non_edge_schema():
    async def traverse(ctx, spec, projection=None):
        return []

    server = KeymaServer(
        schemas=[PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA, WORKS_AT_SCHEMA],
        adapter=make_fake_adapter(traverse=traverse),
    )
    resp = await server.handle(
        {
            "operations": {
                "t": {
                    "op": "traverse",
                    "schema": "person",
                    "spec": {
                        "start": {"schema": "person", "where": {}},
                        # `person` isn't an edge — bad spec
                        "steps": [{"via": "person", "direction": "out"}],
                        "emit": "nodes",
                    },
                },
            },
        }
    )
    r = resp["results"]["t"]
    assert r["ok"] is False
    assert r["code"] == "NOT_AN_EDGE"


async def test_hydrates_terminal_records_into_terminal_schema_class_instances():
    async def traverse(ctx, spec, projection=None):
        return [
            {"id": "c1", "name": "Acme", "_company": True},
            {"id": "c2", "name": "Globex", "_company": True},
        ]

    adapter = make_fake_adapter(traverse=traverse)
    server = KeymaServer(
        schemas=[PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA, WORKS_AT_SCHEMA],
        adapter=adapter,
    )

    q = Keyma.query(
        {
            "companies": Keyma.traverse(
                Company,
                {
                    "start": {"schema": Person, "where": {"id": "p1"}},
                    "steps": [
                        {"via": Knows, "direction": "out"},
                        {"via": WorksAt, "direction": "out"},
                    ],
                    "emit": "nodes",
                },
            ),
        }
    )

    async def transport(req):
        return await server.handle(req)

    resp = await q.request({}, inputs={}, transport=transport)

    assert resp["results"]["companies"]["ok"] is True
    data = resp["results"]["companies"]["data"]
    assert isinstance(data, list)
    assert len(data) == 2
    assert isinstance(data[0], Company)
    assert data[0].name == "Acme"


# ─── Type narrowing (compile-time assertions in TS) ──────────────────────────
# The TS file's narrowing tests are compile-time checks; only the runtime
# spot-check assertions are ported here.


def test_valid_chain_terminal_type_narrows_to_terminal_class_instance_type():
    leaf = Keyma.traverse(
        Company,
        {
            "start": {"schema": Person, "where": {"id": "p1"}},
            "steps": [
                {"via": Knows, "direction": "out"},
                {"via": WorksAt, "direction": "out"},
            ],
            "emit": "nodes",
        },
    )
    assert leaf.schema_class is Company


def test_invalid_chain_would_be_rejected_by_the_compiler_documented_not_runtime_checked():
    assert True


def test_node_where_is_typed_against_the_connected_node_at_each_step():
    leaf = Keyma.traverse(
        Company,
        {
            "start": {"schema": Person, "where": {"id": "p1"}},
            "steps": [
                {"via": Knows, "direction": "out", "nodeWhere": {"name": "Alice"}},
                {"via": WorksAt, "direction": "out", "nodeWhere": {"name": "Acme"}},
            ],
            "emit": "nodes",
        },
    )
    assert leaf.schema_class is Company

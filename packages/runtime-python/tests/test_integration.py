"""Port of @keyma/runtime-js test/integration.test.ts.

Two describe groups:
  - "template + server end-to-end"
  - "edges — create with node objects, read populates from/to"
"""

from __future__ import annotations

from typing import Any, Dict

from keyma.runtime import Keyma, KeymaServer, create_direct_transport
from keyma.runtime.testing import InMemoryAdapter

from fixtures import (
    User,
    Organization,
    USER_SCHEMA,
    ORGANIZATION_SCHEMA,
    ADDRESS_SCHEMA,
    PERSON_SCHEMA,
    COMPANY_SCHEMA,
    KNOWS_SCHEMA,
)


# Validators ride directly in the schema metadata (see fixtures.py) — no registry.
def setup_server() -> Dict[str, Any]:
    adapter = InMemoryAdapter()
    server = KeymaServer(
        schemas=[USER_SCHEMA, ORGANIZATION_SCHEMA, ADDRESS_SCHEMA],
        adapter=adapter,
    )
    return {"server": server, "adapter": adapter, "transport": create_direct_transport(server)}


# ─── template + server end-to-end ────────────────────────────────────────────


async def test_readme_example_query_with_list_and_read_reference_projection():
    s = setup_server()
    adapter, transport = s["adapter"], s["transport"]
    adapter.stores["organization"] = {"o1": {"id": "o1", "name": "Acme", "tier": "pro"}}
    adapter.stores["user"] = {
        "u1": {"id": "u1", "email": "alice@gmail.com", "name": "Alice", "organization": "o1"},
        "u2": {"id": "u2", "email": "bob@gmail.com", "name": "Bob", "organization": "o1"},
    }

    q = Keyma.query(
        {
            "users": Keyma.list(User, None, {"organization": {"name": 1}}),
            "user": Keyma.read(User, {"id": Keyma.input("id")}, {"organization": {"name": 1}}),
        }
    )

    response = await q.request(
        {"users": {"skip": 0, "limit": 10}},
        inputs={"user": {"id": "u1"}},
        transport=transport,
    )

    assert response["results"]["users"]["ok"] is True
    assert len(response["results"]["users"]["data"]) == 2
    assert response["results"]["users"]["data"][0].organization == {"name": "Acme"}

    assert response["results"]["user"]["ok"] is True
    assert response["results"]["user"]["data"] is not None
    assert response["results"]["user"]["data"].organization == {"name": "Acme"}


async def test_template_is_reusable_across_multiple_request_calls():
    s = setup_server()
    adapter, transport = s["adapter"], s["transport"]
    adapter.stores["user"] = {
        "u1": {"id": "u1", "email": "a@x.com", "name": "Alice"},
        "u2": {"id": "u2", "email": "b@x.com", "name": "Bob"},
    }

    q = Keyma.query(
        {
            "user": Keyma.read(User, {"id": Keyma.input("id")}),
        }
    )

    r1 = await q.request({}, inputs={"user": {"id": "u1"}}, transport=transport)
    r2 = await q.request({}, inputs={"user": {"id": "u2"}}, transport=transport)

    assert r1["results"]["user"]["ok"] is True
    assert r2["results"]["user"]["ok"] is True
    assert r1["results"]["user"]["data"] is not None
    assert r1["results"]["user"]["data"].email == "a@x.com"
    assert r2["results"]["user"]["data"] is not None
    assert r2["results"]["user"]["data"].email == "b@x.com"


async def test_mutation_create_and_delete_are_independent_per_leaf_results():
    s = setup_server()
    transport = s["transport"]

    m = Keyma.mutation(
        {
            "ok": Keyma.create(
                Organization,
                {"name": Keyma.input("name"), "tier": Keyma.input("tier")},
            ),
            "bad": Keyma.create(
                User,
                {"email": Keyma.input("email"), "name": Keyma.input("name")},
            ),
        }
    )

    response = await m.request(
        {},
        inputs={
            "ok": {"name": "Acme", "tier": "pro"},
            "bad": {"email": "not-an-email", "name": "X"},
        },
        transport=transport,
    )

    assert response["results"]["ok"]["ok"] is True
    assert response["results"]["bad"]["ok"] is False
    assert response["results"]["bad"]["code"] == "VALIDATION_FAILED"


async def test_hydrates_response_data_into_schema_class_instances():
    s = setup_server()
    adapter, transport = s["adapter"], s["transport"]
    adapter.stores["user"] = {
        "u1": {"id": "u1", "email": "a@x.com", "name": "Alice"},
        "u2": {"id": "u2", "email": "b@x.com", "name": "Bob"},
    }
    adapter.stores["organization"] = {"o1": {"id": "o1", "name": "Acme", "tier": "pro"}}

    q = Keyma.query(
        {
            "user": Keyma.read(User, {"id": Keyma.input("id")}),
            "users": Keyma.list(User),
            "org": Keyma.read(Organization, {"id": Keyma.input("oid")}),
        }
    )

    resp = await q.request(
        {},
        inputs={"user": {"id": "u1"}, "org": {"oid": "o1"}},
        transport=transport,
    )

    assert resp["results"]["user"]["ok"] is True
    assert resp["results"]["user"]["data"] is not None
    assert isinstance(resp["results"]["user"]["data"], User), "read result should be instanceof User"
    assert resp["results"]["user"]["data"].email == "a@x.com"

    assert resp["results"]["users"]["ok"] is True
    assert len(resp["results"]["users"]["data"]) == 2
    for u in resp["results"]["users"]["data"]:
        assert isinstance(u, User), "list items should be instanceof User"

    assert resp["results"]["org"]["ok"] is True
    assert resp["results"]["org"]["data"] is not None
    assert isinstance(resp["results"]["org"]["data"], Organization)
    assert resp["results"]["org"]["data"].name == "Acme"


async def test_create_update_return_hydrated_instances_delete_returns_null():
    s = setup_server()
    transport, adapter = s["transport"], s["adapter"]
    adapter.stores["organization"] = {"o1": {"id": "o1", "name": "Acme", "tier": "free"}}

    m = Keyma.mutation(
        {
            "made": Keyma.create(
                Organization,
                {"name": Keyma.input("name"), "tier": Keyma.input("tier")},
            ),
            "changed": Keyma.update(
                Organization,
                {"id": Keyma.input("id")},
                {"tier": Keyma.input("tier")},
            ),
            "gone": Keyma.delete(Organization, {"id": Keyma.input("id")}),
        }
    )

    resp = await m.request(
        {},
        inputs={
            "made": {"name": "New Co", "tier": "pro"},
            "changed": {"id": "o1", "tier": "enterprise"},
            "gone": {"id": "o1"},
        },
        transport=transport,
    )

    if resp["results"]["made"]["ok"]:
        assert isinstance(resp["results"]["made"]["data"], Organization)
        assert resp["results"]["made"]["data"].name == "New Co"
    if resp["results"]["changed"]["ok"]:
        assert isinstance(resp["results"]["changed"]["data"], Organization)
        assert resp["results"]["changed"]["data"].tier == "enterprise"
    if resp["results"]["gone"]["ok"]:
        assert resp["results"]["gone"]["data"] is None


async def test_template_can_be_used_with_two_different_transports():
    a = setup_server()
    b = setup_server()
    a["adapter"].stores["user"] = {"u1": {"id": "u1", "email": "a@x.com", "name": "Alice"}}
    b["adapter"].stores["user"] = {"u1": {"id": "u1", "email": "b@x.com", "name": "Bob"}}

    q = Keyma.query(
        {
            "user": Keyma.read(User, {"id": Keyma.input("id")}),
        }
    )

    ra = await q.request({}, inputs={"user": {"id": "u1"}}, transport=a["transport"])
    rb = await q.request({}, inputs={"user": {"id": "u1"}}, transport=b["transport"])

    if ra["results"]["user"]["ok"] and ra["results"]["user"]["data"] is not None:
        assert ra["results"]["user"]["data"].email == "a@x.com"
    if rb["results"]["user"]["ok"] and rb["results"]["user"]["data"] is not None:
        assert rb["results"]["user"]["data"].email == "b@x.com"


# ─── edges — create with node objects, read populates from/to ────────────────


def setup_edge_server() -> Dict[str, Any]:
    adapter = InMemoryAdapter()
    server = KeymaServer(
        schemas=[PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA],
        adapter=adapter,
    )
    adapter.stores["person"] = {
        "p1": {"id": "p1", "name": "Alice"},
        "p2": {"id": "p2", "name": "Bob"},
    }
    return {"server": server, "adapter": adapter}


async def test_create_extracts_ids_from_node_objects_result_returns_id():
    server = setup_edge_server()["server"]
    resp = await server.handle(
        {
            "operations": {
                "c": {
                    "op": "create",
                    "schema": "knows",
                    "data": {
                        "id": "k1",
                        "from": {"id": "p1", "name": "Alice"},
                        "to": {"id": "p2", "name": "Bob"},
                        "since": "2020",
                    },
                },
            },
        }
    )
    r = resp["results"]["c"]
    assert r["ok"] is True, str(r)
    data = r["data"]
    assert data["from"] == {"id": "p1"}
    assert data["to"] == {"id": "p2"}
    assert data["since"] == "2020"


async def test_read_returns_from_to_as_id_by_default():
    server = setup_edge_server()["server"]
    await server.handle(
        {
            "operations": {
                "c": {
                    "op": "create",
                    "schema": "knows",
                    "data": {"id": "k1", "from": {"id": "p1"}, "to": {"id": "p2"}, "since": "2020"},
                },
            },
        }
    )
    resp = await server.handle(
        {
            "operations": {"r": {"op": "read", "schema": "knows", "where": {"id": "k1"}}},
        }
    )
    r = resp["results"]["r"]
    assert r["ok"] is True, str(r)
    data = r["data"]
    assert data["from"] == {"id": "p1"}
    assert data["to"] == {"id": "p2"}


async def test_read_populates_from_to_node_fields_when_projection_requests_them():
    server = setup_edge_server()["server"]
    await server.handle(
        {
            "operations": {
                "c": {
                    "op": "create",
                    "schema": "knows",
                    "data": {"id": "k1", "from": {"id": "p1"}, "to": {"id": "p2"}, "since": "2020"},
                },
            },
        }
    )
    resp = await server.handle(
        {
            "operations": {
                "r": {
                    "op": "read",
                    "schema": "knows",
                    "where": {"id": "k1"},
                    "project": {"since": 1, "from": {"name": 1}, "to": 1},
                },
            },
        }
    )
    r = resp["results"]["r"]
    assert r["ok"] is True, str(r)
    data = r["data"]
    assert data["from"] == {"name": "Alice", "id": "p1"}
    assert data["to"] == {"id": "p2"}
    assert data["since"] == "2020"

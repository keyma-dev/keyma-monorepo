"""Port of ``@keyma/runtime-js`` ``test/count.test.ts``.

describe group: "Keyma.count"
"""

import pytest

from keyma.runtime import Keyma, Input, KeymaServer, create_direct_transport
from keyma.runtime.testing import InMemoryAdapter

from fixtures import User, USER_SCHEMA


# ── Fixtures ─────────────────────────────────────────────────────────────────


def populate(adapter: InMemoryAdapter) -> None:
    adapter.stores["user"] = {
        "u1": {"id": "u1", "email": "alice1@example.com", "name": "Alice"},
        "u2": {"id": "u2", "email": "alice2@example.com", "name": "Alice"},
        "u3": {"id": "u3", "email": "carol@example.com", "name": "Carol"},
    }


# ── Tests ────────────────────────────────────────────────────────────────────


async def test_total_count_via_direct_server_call():
    adapter = InMemoryAdapter()
    populate(adapter)
    server = KeymaServer(schemas=[USER_SCHEMA], adapter=adapter)
    res = await server.handle({"operations": {"n": {"op": "count", "schema": "user"}}})
    assert res["results"]["n"]["ok"] == True
    assert res["results"]["n"]["data"] == 3


async def test_filtered_count_via_native_adapter_count():
    adapter = InMemoryAdapter()
    populate(adapter)
    server = KeymaServer(schemas=[USER_SCHEMA], adapter=adapter)
    res = await server.handle(
        {"operations": {"n": {"op": "count", "schema": "user", "where": {"name": "Alice"}}}}
    )
    assert res["results"]["n"]["ok"] == True
    assert res["results"]["n"]["data"] == 2


async def test_fallback_to_list_length_when_adapter_has_no_count_method():
    adapter = InMemoryAdapter()
    populate(adapter)
    server = KeymaServer(schemas=[USER_SCHEMA], adapter=adapter)
    res = await server.handle({"operations": {"n": {"op": "count", "schema": "user"}}})
    assert res["results"]["n"]["ok"] == True
    assert res["results"]["n"]["data"] == 3


async def test_input_placeholder_in_where_clause_substituted_correctly():
    adapter = InMemoryAdapter()
    populate(adapter)
    transport = create_direct_transport(KeymaServer(schemas=[USER_SCHEMA], adapter=adapter))

    q = Keyma.query({"n": Keyma.count(User, {"name": Input("name")})})

    response = await q.request({}, inputs={"n": {"name": "Alice"}}, transport=transport)
    results = response["results"]

    assert results["n"]["ok"] == True
    n = results["n"]["data"]
    assert n == 2


async def test_end_to_end_via_keyma_query_with_create_direct_transport_data_typed_as_number():
    adapter = InMemoryAdapter()
    populate(adapter)
    transport = create_direct_transport(KeymaServer(schemas=[USER_SCHEMA], adapter=adapter))

    q = Keyma.query({"n": Keyma.count(User)})
    response = await q.request({}, inputs={}, transport=transport)
    results = response["results"]

    assert results["n"]["ok"] == True
    n = results["n"]["data"]
    assert n == 3


async def test_transform_filter_plugin_hook_fires_with_action_count_and_augmented_filter_applies():
    adapter = InMemoryAdapter()
    populate(adapter)

    filter_actions: list = []

    class AclPlugin:
        name = "acl"

        def transform_filter(self, ctx, schema, where, action):
            filter_actions.append(action)
            # Restrict to Alice only
            return {**where, "name": "Alice"}

    server = KeymaServer(schemas=[USER_SCHEMA], adapter=adapter, plugins=[AclPlugin()])
    res = await server.handle({"operations": {"n": {"op": "count", "schema": "user"}}})

    assert filter_actions == ["count"]
    assert res["results"]["n"]["ok"] == True
    assert res["results"]["n"]["data"] == 2


async def test_unknown_schema_returns_schema_not_found_failure():
    adapter = InMemoryAdapter()
    server = KeymaServer(schemas=[USER_SCHEMA], adapter=adapter)
    res = await server.handle({"operations": {"n": {"op": "count", "schema": "nonexistent"}}})
    assert res["results"]["n"]["ok"] == False
    assert res["results"]["n"]["code"] == "SCHEMA_NOT_FOUND"

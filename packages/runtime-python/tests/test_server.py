"""Port of @keyma/runtime-js test/server.test.ts.

Covers KeymaServer single-leaf operations, private schema visibility,
ephemeral schemas, batch isolation, and projection.

Validators/formatters ride directly in the schema metadata (see fixtures.py) —
no registries are wired into the server.
"""

from __future__ import annotations

from typing import Any, Dict, Tuple

from keyma.runtime import KeymaServer
from keyma.runtime.testing import InMemoryAdapter

from fixtures import (
    USER_SCHEMA,
    ORGANIZATION_SCHEMA,
    ADDRESS_SCHEMA,
    SECRET_SCHEMA,
    LOGIN_INPUT_SCHEMA,
)


def make_server() -> Tuple[KeymaServer, InMemoryAdapter]:
    adapter = InMemoryAdapter()
    server = KeymaServer(
        schemas=[USER_SCHEMA, ORGANIZATION_SCHEMA, ADDRESS_SCHEMA],
        adapter=adapter,
    )
    return server, adapter


# ─── KeymaServer — single-leaf operations ─────────────────────────────────────


async def test_create_applies_save_phase_formatters_and_validates_payload():
    server, adapter = make_server()
    req: Dict[str, Any] = {
        "operations": {
            "a": {
                "op": "create",
                "schema": "user",
                "data": {"email": "  USER@EXAMPLE.COM  ", "name": "Alice"},
            },
        },
    }
    resp = await server.handle(req)
    a = resp["results"]["a"]
    assert a["ok"] is True
    assert a["data"]["email"] == "user@example.com"
    stored = list(adapter.stores["user"].values())[0]
    assert stored["email"] == "user@example.com"


async def test_create_returns_validation_failed_with_errors_when_invalid():
    server, _ = make_server()
    resp = await server.handle(
        {
            "operations": {
                "a": {"op": "create", "schema": "user", "data": {"email": "not-email", "name": "X"}},
            },
        }
    )
    a = resp["results"]["a"]
    assert a["ok"] is False
    assert a["code"] == "VALIDATION_FAILED"
    codes = sorted(e["code"] for e in (a.get("errors") or []))
    assert codes == ["emailAddress", "minLength"]


async def test_create_skips_validation_of_readonly_fields_like_id():
    server, _ = make_server()
    # 'id' is readonly + required; client did not supply it. Should still pass.
    resp = await server.handle(
        {
            "operations": {
                "a": {"op": "create", "schema": "user", "data": {"email": "u@x.com", "name": "Alice"}},
            },
        }
    )
    a = resp["results"]["a"]
    assert a["ok"] is True


async def test_read_returns_not_found_for_missing_records():
    server, _ = make_server()
    resp = await server.handle(
        {
            "operations": {
                "a": {"op": "read", "schema": "user", "where": {"id": "nope"}},
            },
        }
    )
    a = resp["results"]["a"]
    assert a["ok"] is False
    assert a["code"] == "NOT_FOUND"


async def test_read_strips_private_fields_from_response_by_default():
    server, adapter = make_server()
    adapter.stores["user"] = {"u1": {"id": "u1", "email": "a@b.com", "name": "Alice", "secret": "shh"}}
    resp = await server.handle(
        {
            "operations": {
                "a": {"op": "read", "schema": "user", "where": {"id": "u1"}},
            },
        }
    )
    a = resp["results"]["a"]
    assert a["ok"] is True
    assert ("secret" in a["data"]) is False


async def test_list_applies_skip_and_limit_from_options():
    server, adapter = make_server()
    store: Dict[str, Dict[str, Any]] = {}
    for i in range(1, 6):
        store[f"u{i}"] = {"id": f"u{i}", "email": f"u{i}@x.com", "name": f"User{i}"}
    adapter.stores["user"] = store
    resp = await server.handle(
        {
            "operations": {
                "a": {"op": "list", "schema": "user", "options": {"skip": 1, "limit": 2}},
            },
        }
    )
    a = resp["results"]["a"]
    assert len(a["data"]) == 2
    assert a["data"][0]["id"] == "u2"


async def test_update_applies_save_phase_formatters():
    server, adapter = make_server()
    adapter.stores["user"] = {"u1": {"id": "u1", "email": "old@x.com", "name": "Alice"}}
    await server.handle(
        {
            "operations": {
                "a": {
                    "op": "update",
                    "schema": "user",
                    "where": {"id": "u1"},
                    "data": {"email": "  NEW@X.COM  "},
                },
            },
        }
    )
    assert adapter.stores["user"]["u1"]["email"] == "new@x.com"


async def test_delete_removes_the_record():
    server, adapter = make_server()
    adapter.stores["user"] = {"u1": {"id": "u1", "email": "a@b.com", "name": "Alice"}}
    resp = await server.handle(
        {
            "operations": {
                "a": {"op": "delete", "schema": "user", "where": {"id": "u1"}},
            },
        }
    )
    a = resp["results"]["a"]
    assert a["ok"] is True
    assert ("u1" in adapter.stores["user"]) is False


async def test_unknown_schema_schema_not_found():
    server, _ = make_server()
    resp = await server.handle(
        {
            "operations": {
                "a": {"op": "read", "schema": "ghost", "where": {"id": "x"}},
            },
        }
    )
    a = resp["results"]["a"]
    assert a["code"] == "SCHEMA_NOT_FOUND"


# ─── KeymaServer — private schema visibility ──────────────────────────────────


def make_server_with_secret() -> Tuple[KeymaServer, InMemoryAdapter]:
    adapter = InMemoryAdapter()
    server = KeymaServer(
        schemas=[USER_SCHEMA, ORGANIZATION_SCHEMA, ADDRESS_SCHEMA, SECRET_SCHEMA],
        adapter=adapter,
    )
    return server, adapter


async def test_rejects_ops_targeting_a_private_schema_with_schema_not_found():
    server, adapter = make_server_with_secret()
    adapter.stores["secret"] = {"s1": {"id": "s1", "value": "shh"}}
    resp = await server.handle(
        {
            "operations": {
                "a": {"op": "read", "schema": "secret", "where": {"id": "s1"}},
                "b": {"op": "list", "schema": "secret"},
            },
        }
    )
    a = resp["results"]["a"]
    b = resp["results"]["b"]
    assert a["code"] == "SCHEMA_NOT_FOUND"
    assert b["code"] == "SCHEMA_NOT_FOUND"


async def test_returns_the_same_code_for_private_schemas_as_for_nonexistent_ones():
    # The attacker-supplied name is echoed in the error message, which is fine —
    # they already know what they asked for. What matters is that the *code* is
    # indistinguishable, so a probe can't tell `private` from `nonexistent`.
    server, _ = make_server_with_secret()
    resp = await server.handle(
        {
            "operations": {
                "priv": {"op": "read", "schema": "secret", "where": {"id": "x"}},
                "ghost": {"op": "read", "schema": "ghost", "where": {"id": "x"}},
            },
        }
    )
    priv = resp["results"]["priv"]
    ghost = resp["results"]["ghost"]
    assert priv["code"] == ghost["code"]
    assert priv["source"] == ghost["source"]


async def test_system_identity_bypasses_the_visibility_guard():
    server, adapter = make_server_with_secret()
    adapter.stores["secret"] = {"s1": {"id": "s1", "value": "shh"}}
    resp = await server.handle(
        {
            "operations": {
                "a": {"op": "read", "schema": "secret", "where": {"id": "s1"}},
            },
        },
        {"identity": {"isSystem": True}},
    )
    a = resp["results"]["a"]
    assert a["ok"] is True
    assert a["data"]["value"] == "shh"


# ─── KeymaServer — ephemeral schemas ──────────────────────────────────────────


def make_server_with_ephemeral() -> Tuple[KeymaServer, InMemoryAdapter]:
    adapter = InMemoryAdapter()
    server = KeymaServer(
        schemas=[USER_SCHEMA, LOGIN_INPUT_SCHEMA],
        adapter=adapter,
    )
    return server, adapter


async def test_ensure_schemas_does_not_provision_a_store_for_an_ephemeral_schema():
    server, adapter = make_server_with_ephemeral()
    await server.ensure_schemas()
    assert ("loginInput" in adapter.stores) is False
    assert ("user" in adapter.stores) is True


async def test_rejects_crud_ops_targeting_an_ephemeral_schema_with_not_persisted():
    server, _ = make_server_with_ephemeral()
    resp = await server.handle(
        {
            "operations": {
                "a": {"op": "create", "schema": "loginInput", "data": {"email": "a@b.com", "password": "x"}},
                "b": {"op": "list", "schema": "loginInput"},
            },
        }
    )
    a = resp["results"]["a"]
    b = resp["results"]["b"]
    assert a["ok"] is False
    assert a["code"] == "NOT_PERSISTED"
    assert b["code"] == "NOT_PERSISTED"


# ─── KeymaServer — batch isolation ────────────────────────────────────────────


async def test_a_failing_leaf_does_not_poison_the_others():
    server, adapter = make_server()
    adapter.stores["user"] = {"u1": {"id": "u1", "email": "a@b.com", "name": "Alice"}}
    resp = await server.handle(
        {
            "operations": {
                "hit": {"op": "read", "schema": "user", "where": {"id": "u1"}},
                "miss": {"op": "read", "schema": "user", "where": {"id": "nope"}},
            },
        }
    )
    hit = resp["results"]["hit"]
    miss = resp["results"]["miss"]
    assert hit["ok"] is True
    assert miss["ok"] is False
    assert miss["code"] == "NOT_FOUND"


# ─── KeymaServer — projection ─────────────────────────────────────────────────


async def test_reference_1_leaves_the_id_nested_object_resolves_via_adapter_populate():
    server, adapter = make_server()
    adapter.stores["organization"] = {"o1": {"id": "o1", "name": "Acme", "tier": "pro"}}
    adapter.stores["user"] = {
        "u1": {"id": "u1", "email": "a@b.com", "name": "Alice", "organization": "o1"}
    }

    # sub === 1: id passes through unchanged
    r1 = await server.handle(
        {
            "operations": {
                "a": {
                    "op": "read",
                    "schema": "user",
                    "where": {"id": "u1"},
                    "project": {"organization": 1},
                },
            },
        }
    )
    a1 = r1["results"]["a"]
    assert a1["data"]["organization"] == "o1"

    # nested projection: resolved + projected
    r2 = await server.handle(
        {
            "operations": {
                "a": {
                    "op": "read",
                    "schema": "user",
                    "where": {"id": "u1"},
                    "project": {"organization": {"name": 1}},
                },
            },
        }
    )
    a2 = r2["results"]["a"]
    assert a2["data"]["organization"] == {"name": "Acme"}


async def test_embedded_picks_listed_fields_from_inline_data():
    server, adapter = make_server()
    adapter.stores["user"] = {
        "u1": {
            "id": "u1",
            "email": "a@b.com",
            "name": "Alice",
            "address": {"line1": "123 Main", "city": "Springfield", "postalCode": "12345"},
        }
    }
    resp = await server.handle(
        {
            "operations": {
                "a": {
                    "op": "read",
                    "schema": "user",
                    "where": {"id": "u1"},
                    "project": {"address": {"city": 1}},
                },
            },
        }
    )
    a = resp["results"]["a"]
    assert a["data"]["address"] == {"city": "Springfield"}


async def test_missing_referenced_record_becomes_null():
    server, adapter = make_server()
    adapter.stores["organization"] = {}
    adapter.stores["user"] = {
        "u1": {"id": "u1", "email": "a@b.com", "name": "Alice", "organization": "missing"}
    }
    resp = await server.handle(
        {
            "operations": {
                "a": {
                    "op": "read",
                    "schema": "user",
                    "where": {"id": "u1"},
                    "project": {"organization": {"name": 1}},
                },
            },
        }
    )
    a = resp["results"]["a"]
    assert a["data"]["organization"] is None

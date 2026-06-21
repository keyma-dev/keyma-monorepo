"""Port of ``@keyma/runtime-js`` ``test/query.test.ts``.

Covers two describe groups:
  - "Keyma builders — leaf shape"
  - "Keyma.query / Keyma.mutation — request substitution"
"""

from __future__ import annotations

from datetime import datetime

import pytest

from keyma.runtime import Keyma, Input
from keyma.runtime._iso import to_iso

from fixtures import User, Organization, Address, UserWithRefs


# ── Keyma builders — leaf shape ───────────────────────────────────────────────


def test_keyma_list_produces_a_list_leaf_with_the_schema_class():
    leaf = Keyma.list(User)
    assert leaf.op == "list"
    assert leaf.schema_class is User
    assert leaf.project is None


def test_keyma_list_accepts_a_project_arg_and_stores_it():
    leaf = Keyma.list(User, None, {"id": 1, "email": 1})
    assert leaf.project == {"id": 1, "email": 1}


def test_keyma_list_accepts_a_where_arg_with_input_placeholders():
    leaf = Keyma.list(User, {"email": Keyma.input("emailSearch")})
    assert leaf.op == "list"
    where = leaf.where
    assert isinstance(where["email"], Input)
    assert where["email"].name == "emailSearch"


def test_keyma_read_stores_where_with_input_placeholders_intact():
    leaf = Keyma.read(User, {"id": Keyma.input("id")})
    assert leaf.op == "read"
    where = leaf.where
    assert isinstance(where["id"], Input)
    assert where["id"].name == "id"


def test_keyma_create_stores_data_with_input_placeholders_intact():
    leaf = Keyma.create(
        User,
        {"email": Keyma.input("email"), "name": Keyma.input("name")},
    )
    assert leaf.op == "create"
    data = leaf.data
    assert data["email"].name == "email"
    assert data["name"].name == "name"


def test_keyma_update_stores_both_where_and_data():
    leaf = Keyma.update(
        User,
        {"id": Keyma.input("id")},
        {"name": Keyma.input("newName")},
    )
    assert leaf.op == "update"
    assert leaf.where["id"].name == "id"
    assert leaf.data["name"].name == "newName"


def test_keyma_delete_stores_where_only():
    leaf = Keyma.delete(User, {"id": Keyma.input("id")})
    assert leaf.op == "delete"
    assert leaf.data is None


def test_keyma_input_returns_a_placeholder_with_the_given_name():
    placeholder = Keyma.input("myParam")
    assert isinstance(placeholder, Input)
    assert placeholder.name == "myParam"


# ── Keyma.query / Keyma.mutation — request substitution ───────────────────────


async def test_substitutes_inputs_into_the_wire_request_and_forwards_list_options():
    captured = []

    async def transport(req):
        captured.append(req)
        return {"results": {}}

    q = Keyma.query(
        {
            "users": Keyma.list(User, None, {"id": 1, "email": 1}),
            "user": Keyma.read(User, {"id": Keyma.input("id")}),
        }
    )

    await q.request(
        {"users": {"skip": 5, "limit": 10}},
        inputs={"user": {"id": "u-42"}},
        transport=transport,
    )

    assert len(captured) == 1
    req = captured[0]
    assert req["operations"]["users"] == {
        "op": "list",
        "schema": "user",
        "project": {"id": 1, "email": 1},
        "options": {"skip": 5, "limit": 10},
    }
    assert req["operations"]["user"] == {
        "op": "read",
        "schema": "user",
        "where": {"id": "u-42"},
    }


async def test_throws_if_a_required_input_is_missing_from_leaf_inputs():
    async def transport(req):
        return {"results": {}}

    q = Keyma.query({"user": Keyma.read(User, {"id": Keyma.input("id")})})
    with pytest.raises(ValueError, match=r'Missing parameter "id"'):
        await q.request({}, inputs={}, transport=transport)


async def test_keyma_mutation_builds_a_mutation_document_per_leaf_inputs_substituted():
    captured = []

    async def transport(req):
        captured.append(req)
        return {"results": {}}

    m = Keyma.mutation(
        {
            "createOrg": Keyma.create(
                Organization,
                {"name": Keyma.input("name"), "tier": Keyma.input("tier")},
            ),
            "removeOrg": Keyma.delete(Organization, {"id": Keyma.input("id")}),
        }
    )

    await m.request(
        {},
        inputs={
            "createOrg": {"name": "Acme", "tier": "pro"},
            "removeOrg": {"id": "org-99"},
        },
        transport=transport,
    )

    req = captured[0]
    assert req["operations"]["createOrg"] == {
        "op": "create",
        "schema": "organization",
        "data": {"name": "Acme", "tier": "pro"},
    }
    assert req["operations"]["removeOrg"] == {
        "op": "delete",
        "schema": "organization",
        "where": {"id": "org-99"},
    }


async def test_returns_the_typed_results_object_hydrated_into_class_instances():
    async def transport(req):
        return {
            "results": {
                "user": {"ok": True, "data": {"id": "u1", "email": "a@b.com"}},
            }
        }

    q = Keyma.query({"user": Keyma.read(User, {"id": Keyma.input("id")})})
    resp = await q.request({}, inputs={"user": {"id": "u1"}}, transport=transport)
    assert resp["results"]["user"]["ok"] is True
    if resp["results"]["user"]["ok"] and resp["results"]["user"]["data"] is not None:
        assert isinstance(resp["results"]["user"]["data"], User)
        assert resp["results"]["user"]["data"].id == "u1"
        assert resp["results"]["user"]["data"].email == "a@b.com"


async def test_hydrates_nested_embedded_reference_and_datetime_fields_when_refs_populated():
    iso = "2024-05-16T10:00:00.000Z"

    async def transport(req):
        return {
            "results": {
                "bareRef": {
                    "ok": True,
                    "data": {
                        "id": "u1",
                        "email": "a@b.com",
                        "name": "Alice",
                        "organization": "o1",
                        "address": {"line1": "1 Main", "city": "Springfield", "postalCode": "12345"},
                        "createdAt": iso,
                    },
                },
                "populatedRef": {
                    "ok": True,
                    "data": {
                        "id": "u2",
                        "email": "b@b.com",
                        "name": "Bob",
                        "organization": {"id": "o1", "name": "Acme", "tier": "pro"},
                        "address": {"line1": "2 Oak", "city": "Shelbyville", "postalCode": "67890"},
                        "createdAt": iso,
                    },
                },
                "listed": {
                    "ok": True,
                    "data": [
                        {
                            "id": "u3",
                            "email": "c@b.com",
                            "name": "Carol",
                            "organization": "o1",
                            "address": {"line1": "3 Pine", "city": "Capital City", "postalCode": "11111"},
                            "createdAt": iso,
                        }
                    ],
                },
            }
        }

    q = Keyma.query(
        {
            "bareRef": Keyma.read(UserWithRefs, {"id": Keyma.input("id")}),
            "populatedRef": Keyma.read(UserWithRefs, {"id": Keyma.input("id2")}),
            "listed": Keyma.list(UserWithRefs),
        }
    )

    resp = await q.request(
        {},
        inputs={"bareRef": {"id": "u1"}, "populatedRef": {"id2": "u2"}},
        transport=transport,
    )

    assert resp["results"]["bareRef"]["ok"] is True
    if resp["results"]["bareRef"]["ok"] and resp["results"]["bareRef"]["data"] is not None:
        u = resp["results"]["bareRef"]["data"]
        assert isinstance(u, UserWithRefs)
        assert isinstance(u.organization, Organization)
        assert u.organization.id == "o1"
        assert getattr(u.organization, "name", None) is None
        assert isinstance(u.address, Address)
        assert u.address.city == "Springfield"
        assert isinstance(u.createdAt, datetime)
        assert to_iso(u.createdAt) == iso

    assert resp["results"]["populatedRef"]["ok"] is True
    if resp["results"]["populatedRef"]["ok"] and resp["results"]["populatedRef"]["data"] is not None:
        u = resp["results"]["populatedRef"]["data"]
        assert isinstance(u, UserWithRefs)
        assert isinstance(u.organization, Organization)
        assert u.organization.name == "Acme"
        assert u.organization.tier == "pro"
        assert isinstance(u.address, Address)
        assert isinstance(u.createdAt, datetime)

    assert resp["results"]["listed"]["ok"] is True
    if resp["results"]["listed"]["ok"]:
        assert len(resp["results"]["listed"]["data"]) == 1
        u = resp["results"]["listed"]["data"][0]
        assert isinstance(u, UserWithRefs)
        assert isinstance(u.organization, Organization)
        assert isinstance(u.address, Address)
        assert isinstance(u.createdAt, datetime)


# ── reference id normalization (through the builder) ──────────────────────────


def _capturing():
    captured = []

    async def transport(req):
        captured.append(req)
        return {"results": {}}

    return captured, transport


async def test_list_where_bare_reference_id_passes_through():
    captured, transport = _capturing()
    await Keyma.query({"u": Keyma.list(User, {"organization": "o1"})}).request(
        {}, inputs={}, transport=transport
    )
    assert captured[0]["operations"]["u"]["where"] == {"organization": "o1"}


async def test_list_where_id_dict_collapses_to_bare_id():
    captured, transport = _capturing()
    await Keyma.query({"u": Keyma.list(User, {"organization": {"id": "o1"}})}).request(
        {}, inputs={}, transport=transport
    )
    assert captured[0]["operations"]["u"]["where"] == {"organization": "o1"}


async def test_create_data_id_dict_collapses_other_fields_untouched():
    captured, transport = _capturing()
    await Keyma.mutation(
        {"c": Keyma.create(User, {"email": "a@b.com", "name": "Al", "organization": {"id": "o1"}})}
    ).request({}, inputs={}, transport=transport)
    assert captured[0]["operations"]["c"]["data"] == {
        "email": "a@b.com",
        "name": "Al",
        "organization": "o1",
    }


async def test_update_data_full_instance_collapses_to_bare_id():
    captured, transport = _capturing()
    org = Organization({"id": "o1", "name": "Acme", "tier": "pro"})
    await Keyma.mutation(
        {"u": Keyma.update(User, {"id": "u1"}, {"organization": org})}
    ).request({}, inputs={}, transport=transport)
    op = captured[0]["operations"]["u"]
    assert op["where"] == {"id": "u1"}
    assert op["data"]["organization"] == "o1"


async def test_list_where_query_operators_with_bare_ids_preserved():
    captured, transport = _capturing()
    await Keyma.query({"u": Keyma.list(User, {"organization": {"$in": ["o1", "o2"]}})}).request(
        {}, inputs={}, transport=transport
    )
    assert captured[0]["operations"]["u"]["where"] == {"organization": {"$in": ["o1", "o2"]}}


async def test_normalization_runs_after_input_substitution():
    captured, transport = _capturing()
    await Keyma.query({"u": Keyma.read(User, {"organization": Keyma.input("org")})}).request(
        {}, inputs={"u": {"org": {"id": "o1"}}}, transport=transport
    )
    assert captured[0]["operations"]["u"]["where"] == {"organization": "o1"}


async def test_embedded_fields_are_not_collapsed():
    captured, transport = _capturing()
    address = {"line1": "1 Main", "city": "Springfield", "postalCode": "12345"}
    await Keyma.mutation(
        {"c": Keyma.create(User, {"email": "a@b.com", "name": "Al", "address": address})}
    ).request({}, inputs={}, transport=transport)
    assert captured[0]["operations"]["c"]["data"]["address"] == address

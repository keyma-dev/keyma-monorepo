"""Port of @keyma/runtime-js test/serialize.test.ts (describe "serialize")."""

from __future__ import annotations

from typing import Any, Dict

from keyma.runtime import serialize


SCHEMA: Dict[str, Any] = {
    "name": "user",
    "sourceName": "User",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "readonly": True},
        {"name": "email", "type": {"kind": "string"}},
        {"name": "secret", "type": {"kind": "string"}, "visibility": "private", "required": False},
        {"name": "fullName", "type": {"kind": "string"}, "required": False, "computed": True, "ephemeral": True},
    ],
}


def test_client_target_strips_private_fields():
    out = serialize(
        SCHEMA,
        {"id": "u1", "email": "a@b.com", "secret": "x", "fullName": "A B"},
        target="client",
    )
    assert out == {"id": "u1", "email": "a@b.com", "fullName": "A B"}


def test_server_target_keeps_all_fields():
    out = serialize(
        SCHEMA,
        {"id": "u1", "email": "a@b.com", "secret": "x", "fullName": "A B"},
        target="server",
    )
    assert out == {"id": "u1", "email": "a@b.com", "secret": "x", "fullName": "A B"}


def test_database_target_strips_ephemeral_computed_fields():
    out = serialize(
        SCHEMA,
        {"id": "u1", "email": "a@b.com", "secret": "x", "fullName": "A B"},
        target="database",
    )
    assert out == {"id": "u1", "email": "a@b.com", "secret": "x"}


def test_omits_keys_not_present_in_the_value():
    out = serialize(SCHEMA, {"id": "u1"}, target="client")
    assert out == {"id": "u1"}

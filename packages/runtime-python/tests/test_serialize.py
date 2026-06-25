"""Port of @keyma/runtime-js test/serialize.test.ts (describe "serialize")."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict

from keyma.runtime import serialize


SCHEMA: Dict[str, Any] = {
    "name": "user",
    "sourceName": "User",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "readonly": True},
        {"name": "email", "type": {"kind": "string"}},
        {"name": "secret", "type": {"kind": "string"}, "visibility": "private", "required": False},
        {"name": "scratch", "type": {"kind": "string"}, "required": False, "ephemeral": True},
    ],
}


def test_client_target_strips_private_fields():
    out = serialize(
        SCHEMA,
        {"id": "u1", "email": "a@b.com", "secret": "x", "scratch": "tmp"},
        target="client",
    )
    assert out == {"id": "u1", "email": "a@b.com", "scratch": "tmp"}


def test_server_target_keeps_all_fields():
    out = serialize(
        SCHEMA,
        {"id": "u1", "email": "a@b.com", "secret": "x", "scratch": "tmp"},
        target="server",
    )
    assert out == {"id": "u1", "email": "a@b.com", "secret": "x", "scratch": "tmp"}


def test_database_target_strips_ephemeral_fields():
    out = serialize(
        SCHEMA,
        {"id": "u1", "email": "a@b.com", "secret": "x", "scratch": "tmp"},
        target="database",
    )
    assert out == {"id": "u1", "email": "a@b.com", "secret": "x"}


def test_omits_keys_not_present_in_the_value():
    out = serialize(SCHEMA, {"id": "u1"}, target="client")
    assert out == {"id": "u1"}


def test_encodes_datetime_as_epoch_ms_and_bytes_as_base64():
    schema: Dict[str, Any] = {
        "name": "wire",
        "sourceName": "Wire",
        "fields": [
            {"name": "when", "type": {"kind": "dateTime"}},
            {"name": "blob", "type": {"kind": "bytes"}},
        ],
    }
    out = serialize(
        schema,
        {
            "when": datetime(2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc),
            "blob": bytes([0, 1, 2, 253, 254, 255]),
        },
        target="server",
    )
    assert out["when"] == 1704164645000
    assert isinstance(out["when"], int)
    assert out["blob"] == "AAEC/f7/"


def test_serializes_naive_datetime_as_utc_epoch_ms():
    schema: Dict[str, Any] = {
        "name": "wire",
        "sourceName": "Wire",
        "fields": [{"name": "when", "type": {"kind": "dateTime"}}],
    }
    out = serialize(schema, {"when": datetime(2024, 1, 2, 3, 4, 5)}, target="server")
    assert out["when"] == 1704164645000  # naive assumed UTC, not local

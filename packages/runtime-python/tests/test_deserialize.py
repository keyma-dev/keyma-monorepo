"""JSON deserialization / hydration — target-free.

Converts epoch-ms ``dateTime`` ints to :class:`datetime`, base64 ``bytes`` strings to bytes, and
hydrates embedded subobjects + reference stubs via each target class's static ``from_value``."""

from __future__ import annotations

import base64
from datetime import datetime, timezone

from keyma.runtime import deserialize, deserialize_value

from _generated import Address, User


def test_deserialize_instantiates_embedded_and_parses_datetime():
    out = deserialize(
        User.metadata,
        {"id": "u1", "name": "Ada", "age": 1, "address": {"line1": "1 St", "city": "Town"}, "createdAt": 1704164645000},
    )
    assert isinstance(out["address"], Address)
    assert out["address"].city == "Town"
    assert isinstance(out["createdAt"], datetime)
    assert out["createdAt"] == datetime(2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc)


def test_deserialize_only_known_fields():
    out = deserialize(User.metadata, {"name": "Ada", "unknown": "x"})
    assert out == {"name": "Ada"}


def test_round_trip_json():
    from keyma.runtime import serialize

    original = {
        "id": "u1",
        "name": "Ada",
        "age": 36,
        "address": {"line1": "1 St", "city": "Town"},
        "createdAt": datetime(2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc),
    }
    wire = serialize(User.metadata, original)
    back = deserialize(User.metadata, wire)
    assert back["name"] == "Ada"
    assert back["age"] == 36
    assert isinstance(back["address"], Address)
    assert back["address"].line1 == "1 St"
    assert back["createdAt"] == original["createdAt"]


def test_deserialize_value_bytes_from_base64():
    raw = bytes([9, 8, 7])
    b64 = base64.b64encode(raw).decode("ascii")
    assert deserialize_value(b64, {"kind": "bytes"}, None) == raw


def test_deserialize_value_reference_stub_from_bare_id():
    stub = deserialize_value("u9", {"kind": "reference", "target": "user"}, {"user": User})
    assert isinstance(stub, User)
    assert stub.id == "u9"

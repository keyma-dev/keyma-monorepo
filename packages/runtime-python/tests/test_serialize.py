"""JSON serialization — target-free + visibility-blind (the RPC rewrite dropped SerializeTarget).

Covers ``dateTime``→epoch-ms, ``bytes``→base64, embedded recursion via ``refs``, reference→id,
and arrays. Drives generated-style metadata (``Class.metadata``, ``target``-keyed embedded)."""

from __future__ import annotations

import base64
from datetime import datetime, timezone

from keyma.runtime import serialize, serialize_value

from _generated import Address, User


def test_serialize_converts_datetime_to_epoch_ms():
    out = serialize(
        User.metadata,
        {"id": "u1", "name": "Ada", "age": 36, "createdAt": datetime(2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc)},
    )
    assert out["createdAt"] == 1704164645000
    assert out["id"] == "u1"
    assert out["name"] == "Ada"


def test_serialize_recurses_embedded_via_refs():
    out = serialize(
        User.metadata,
        {"id": "u1", "name": "Ada", "age": 1, "address": {"line1": "1 St", "city": "Town"}},
    )
    assert out["address"] == {"line1": "1 St", "city": "Town"}


def test_serialize_reads_object_instances_and_omits_getters():
    user = User.from_value({"id": "u1", "name": "Ada", "age": 7})
    # A non-field attribute set on the instance is never serialized (codec walks fields only).
    user.transient = "ignore-me"
    out = serialize(User.metadata, user)
    assert "transient" not in out
    assert out["name"] == "Ada"


def test_serialize_is_visibility_blind():
    # A private field is still serialized — private-field exclusion is the compile-time bundle
    # split, not a codec concern.
    meta = {
        "name": "secretful",
        "sourceName": "Secretful",
        "fields": [
            {"name": "id", "type": {"kind": "id"}},
            {"name": "secret", "type": {"kind": "string"}, "visibility": "private"},
        ],
    }
    out = serialize(meta, {"id": "x", "secret": "shh"})
    assert out == {"id": "x", "secret": "shh"}


def test_serialize_value_bytes_to_base64():
    raw = bytes([0, 1, 2, 250])
    assert serialize_value(raw, {"kind": "bytes"}, None) == base64.b64encode(raw).decode("ascii")


def test_serialize_value_array_of_embedded():
    out = serialize_value(
        [{"line1": "a", "city": "b"}, {"line1": "c", "city": "d"}],
        {"kind": "array", "of": {"kind": "embedded", "target": "address"}},
        {"address": Address},
    )
    assert out == [{"line1": "a", "city": "b"}, {"line1": "c", "city": "d"}]


def test_serialize_value_reference_to_bare_id():
    # A reference value reduces to its target's bare id, from an object, a dict, or a scalar.
    assert serialize_value({"id": "u9"}, {"kind": "reference", "target": "user"}, None) == "u9"
    assert serialize_value("u9", {"kind": "reference", "target": "user"}, None) == "u9"

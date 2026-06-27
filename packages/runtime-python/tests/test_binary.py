"""Cross-runtime binary parity for keyma.runtime.

Reads the SAME canonical fixtures the JS reference codec generates
(``packages/runtime/test/binary-fixtures.json``) and asserts byte-identical output, plus
round-trips and the unknown-tag skip (durability) guarantee.

The codec is now **target-free** (the RPC rewrite dropped SerializeTarget): it encodes every
declared field. That matches the ``server``-target fixtures exactly (server kept all fields), so
the byte cross-check is run over those; the field-dropping ``client``/``database`` fixtures no
longer correspond to a target-free encoder and are skipped."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional

import pytest

from keyma.runtime import decode_binary, encode_binary
from keyma.runtime._iso import from_epoch_ms

# Canonical fixtures live in the JS reference runtime (single source of truth).
FIXTURES_PATH = Path(__file__).resolve().parents[2] / "runtime" / "test" / "binary-fixtures.json"


def _from_wire(v: Any) -> Any:
    """Expand the tagged wrappers in a committed fixture record into native values."""
    if isinstance(v, list):
        return [_from_wire(x) for x in v]
    if isinstance(v, dict):
        if "$date" in v:
            return from_epoch_ms(v["$date"])
        if "$bytes" in v:
            return bytes.fromhex(v["$bytes"])
        if "$bigint" in v:
            return int(v["$bigint"])
        return {k: _from_wire(x) for k, x in v.items()}
    return v


def _make_stub(meta: Dict[str, Any]):
    class Stub:
        # Generated classes carry metadata as `.metadata` (the cross-language contract).
        metadata = meta

        def __init__(self, value: Optional[Dict[str, Any]] = None) -> None:
            if value:
                for k, val in value.items():
                    setattr(self, k, val)

    return Stub


def _revive_meta(meta: Dict[str, Any], schemas: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Rebuild a metadata dict with a shared ``refs`` map of stub model classes."""
    refs: Dict[str, Any] = {}
    for name, sub in (schemas or {}).items():
        sub_meta = dict(sub)
        sub_meta["refs"] = refs
        refs[name] = _make_stub(sub_meta)
    out = dict(meta)
    out["refs"] = refs
    return out


def _load_fixtures():
    data = json.loads(FIXTURES_PATH.read_text())
    return data["fixtures"]


# A target-free encoder matches the server-target fixtures (server kept every field).
def _server_fixtures():
    return [f for f in _load_fixtures() if f.get("target", "server") == "server"]


@pytest.mark.parametrize("fixture", _server_fixtures(), ids=lambda f: f["name"])
def test_encodes_to_committed_hex(fixture):
    meta = _revive_meta(fixture["schema"], fixture.get("schemas"))
    record = _from_wire(fixture["record"])
    out = encode_binary(meta, record)
    assert out.hex() == fixture["hex"]


def test_round_trip_scalars():
    fixtures = {f["name"]: f for f in _load_fixtures()}
    f = fixtures["scalars-server"]
    meta = _revive_meta(f["schema"], f.get("schemas"))
    record = _from_wire(f["record"])
    decoded = decode_binary(meta, encode_binary(meta, record))
    assert decoded["title"] == "héllo"
    assert decoded["count"] == 300
    assert decoded["negative"] == -7
    assert decoded["size"] == 4096
    assert decoded["active"] is True
    assert decoded["inactive"] is False
    assert decoded["ratio"] == 3.5
    assert decoded["single"] == 1.5
    assert decoded["created"] == from_epoch_ms(1704164645000)
    assert decoded["blob"] == bytes([0, 1, 2, 253, 254, 255])
    assert decoded["big"] == 9007199254740993


def test_round_trip_arrays_and_embedded():
    fixtures = {f["name"]: f for f in _load_fixtures()}
    arrays = fixtures["arrays"]
    meta = _revive_meta(arrays["schema"], arrays.get("schemas"))
    record = _from_wire(arrays["record"])
    decoded = decode_binary(meta, encode_binary(meta, record))
    assert decoded["tags"] == ["a", "bb", "ccc"]
    assert decoded["nums"] == [1, -2, 300]
    assert decoded["empty"] == []
    assert decoded["sparse"] == ["x", None, "z"]

    emb = fixtures["embedded"]
    meta = _revive_meta(emb["schema"], emb.get("schemas"))
    record = _from_wire(emb["record"])
    decoded = decode_binary(meta, encode_binary(meta, record))
    assert decoded["address"].street == "1 Main"
    assert decoded["address"].zip == "00000"


def test_skips_unknown_tags():
    writer = {
        "name": "evolved",
        "sourceName": "Evolved",
        "fields": [
            {"name": "id", "type": {"kind": "id"}, "tag": 1},
            {"name": "extra", "type": {"kind": "string"}, "tag": 2},
            {"name": "n", "type": {"kind": "integer"}, "tag": 3},
        ],
    }
    reader = {
        "name": "evolved",
        "sourceName": "Evolved",
        "fields": [
            {"name": "id", "type": {"kind": "id"}, "tag": 1},
            {"name": "_gap", "type": {"kind": "string"}, "tag": 99},
            {"name": "n", "type": {"kind": "integer"}, "tag": 3},
        ],
    }
    bytes_ = encode_binary(writer, {"id": "z1", "extra": "dropme", "n": 5})
    decoded = decode_binary(reader, bytes_)
    assert decoded["id"] == "z1"
    assert decoded["n"] == 5
    assert "extra" not in decoded
    assert "_gap" not in decoded

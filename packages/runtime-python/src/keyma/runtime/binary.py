"""Binary wire codec — port of ``@keyma/runtime`` ``binary.ts``.

An alternative encoder of the same per-field data as :func:`serialize`, parallel to JSON, kept
**byte-identical** across the JS / Python / C++ runtimes (varint, zigzag, length-prefixed strings,
per-type encoders — unchanged by the RPC rewrite). :func:`encode_binary` mirrors ``serialize``'s
per-field traversal (same type switch, same ``dateTime``→epoch-ms / ``embedded``→recurse-via-``refs``
/ ``array``→element-map / ``reference``→bare-id conversions) but emits tag-keyed TLV tokens;
``bytes`` stay raw (not base64). :func:`decode_binary` is the inverse, hydrating like
:func:`deserialize`. Field identity on the wire is ``field["tag"]`` when present, else the 1-based
declaration index. Target-free + visibility-blind.

:func:`encode_arg` / :func:`decode_arg` expose the per-value (no-tag) payload codec the RPC
marshaller uses for positional service arguments and return payloads."""

from __future__ import annotations

import struct
from datetime import datetime
from typing import Any, Dict, List, Optional

from ._iso import from_epoch_ms, to_epoch_ms
from ._shared import Metadata, _class_meta, _hydrate, _is_record, _read, _ref_name
from .fields import all_fields, all_refs
from .types import FieldType

# Wire types — the low 3 bits of each field key (= tag * 8 + wiretype).
WIRE_VARINT = 0
WIRE_FIXED64 = 1
WIRE_LENGTH = 2
WIRE_NULL = 3
WIRE_FIXED32 = 4

# Generic self-describing kinds for `json` fields.
_JSON_NULL, _JSON_FALSE, _JSON_TRUE, _JSON_INT, _JSON_FLOAT = 0, 1, 2, 3, 4
_JSON_STRING, _JSON_ARRAY, _JSON_OBJECT, _JSON_BYTES = 5, 6, 7, 8


# ── varint / zigzag primitives ─────────────────────────────────────────────────


def write_varint(out: bytearray, value: int) -> None:
    if value < 0:
        raise ValueError("write_varint: value must be non-negative")
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)


def zigzag_encode(n: int) -> int:
    return (n << 1) ^ (n >> 63)


def zigzag_decode(u: int) -> int:
    return (u >> 1) ^ -(u & 1)


# ── Encoding ───────────────────────────────────────────────────────────────────


def encode_binary(meta: Metadata, value: Any) -> bytes:
    out = bytearray()
    _encode_record(out, meta, value)
    return bytes(out)


def _encode_record(out: bytearray, meta: Metadata, value: Any) -> None:
    refs = all_refs(meta)  # own + inherited (real inheritance)
    for i, field in enumerate(all_fields(meta)):
        present, fv = _read(value, field["name"])
        if not present:
            continue
        tag = field.get("tag")
        if tag is None:
            tag = i + 1
        if fv is None:
            _write_key(out, tag, WIRE_NULL)
            continue
        _write_key(out, tag, _wiretype_of(field["type"]))
        _encode_payload(out, field["type"], fv, refs)


def _write_key(out: bytearray, tag: int, wiretype: int) -> None:
    write_varint(out, tag * 8 + wiretype)


def _wiretype_of(type_: FieldType) -> int:
    kind = type_["kind"]
    if kind in ("boolean", "integer", "bigint", "dateTime"):
        return WIRE_VARINT
    if kind == "number":
        return WIRE_FIXED32 if type_.get("bits") == 32 else WIRE_FIXED64
    if kind == "reference":
        id_type = type_.get("idType")
        return WIRE_VARINT if id_type and id_type.get("kind") == "integer" else WIRE_LENGTH
    return WIRE_LENGTH


def _encode_payload(out: bytearray, type_: FieldType, value: Any, refs: Optional[Dict[str, Any]]) -> None:
    kind = type_["kind"]
    if kind == "boolean":
        write_varint(out, 1 if value else 0)
    elif kind == "integer":
        write_varint(out, _to_int(value) if type_.get("unsigned") else zigzag_encode(_to_int(value)))
    elif kind == "bigint":
        write_varint(out, zigzag_encode(_to_int(value)))
    elif kind == "dateTime":
        ms = to_epoch_ms(value) if isinstance(value, datetime) else int(value)
        write_varint(out, zigzag_encode(ms))
    elif kind == "number":
        out += struct.pack("<f" if type_.get("bits") == 32 else "<d", float(value))
    elif kind in ("string", "id", "enum", "date", "time", "decimal"):
        _write_len_bytes(out, str(value).encode("utf-8"))
    elif kind == "bytes":
        _write_len_bytes(out, bytes(value) if isinstance(value, (bytes, bytearray)) else b"")
    elif kind in ("embedded", "instance"):
        sub = (refs or {}).get(_ref_name(type_))
        sub_meta = _class_meta(sub)
        body = bytearray()
        if sub_meta is not None and _is_record(value):
            _encode_record(body, sub_meta, value)
        _write_len_bytes(out, bytes(body))
    elif kind == "reference":
        rid = _ref_id(value)
        id_type = type_.get("idType")
        if id_type and id_type.get("kind") == "integer":
            write_varint(out, _to_int(rid) if id_type.get("unsigned") else zigzag_encode(_to_int(rid)))
        else:
            _write_len_bytes(out, str(rid).encode("utf-8"))
    elif kind == "array":
        arr = value if isinstance(value, list) else []
        body = bytearray()
        write_varint(body, len(arr))
        for el in arr:
            _encode_element(body, type_["of"], el, refs)
        _write_len_bytes(out, bytes(body))
    elif kind == "json":
        body = bytearray()
        _encode_json(body, value)
        _write_len_bytes(out, bytes(body))
    else:
        _write_len_bytes(out, str(value).encode("utf-8"))


def _encode_element(out: bytearray, type_: FieldType, value: Any, refs: Optional[Dict[str, Any]]) -> None:
    if value is None:
        out.append(WIRE_NULL)
        return
    out.append(_wiretype_of(type_))
    _encode_payload(out, type_, value, refs)


def _write_len_bytes(out: bytearray, b: bytes) -> None:
    write_varint(out, len(b))
    out += b


def _encode_json(out: bytearray, value: Any) -> None:
    if value is None:
        out.append(_JSON_NULL)
    elif isinstance(value, bool):  # before int — bool is an int subclass
        out.append(_JSON_TRUE if value else _JSON_FALSE)
    elif isinstance(value, int):
        out.append(_JSON_INT)
        write_varint(out, zigzag_encode(value))
    elif isinstance(value, float):
        out.append(_JSON_FLOAT)
        out += struct.pack("<d", value)
    elif isinstance(value, str):
        out.append(_JSON_STRING)
        _write_len_bytes(out, value.encode("utf-8"))
    elif isinstance(value, (bytes, bytearray)):
        out.append(_JSON_BYTES)
        _write_len_bytes(out, bytes(value))
    elif isinstance(value, list):
        out.append(_JSON_ARRAY)
        write_varint(out, len(value))
        for el in value:
            _encode_json(out, el)
    elif isinstance(value, dict):
        out.append(_JSON_OBJECT)
        write_varint(out, len(value))
        for k, v in value.items():
            _write_len_bytes(out, str(k).encode("utf-8"))
            _encode_json(out, v)
    else:
        out.append(_JSON_NULL)


def _to_int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    return int(value)


def _ref_id(value: Any) -> Any:
    if isinstance(value, dict):
        return value.get("id")
    if isinstance(value, (str, bytes, int, float, bool)):
        return value
    return getattr(value, "id", value)


# ── Decoding ───────────────────────────────────────────────────────────────────


class _Reader:
    __slots__ = ("buf", "pos", "end")

    def __init__(self, buf: bytes, pos: int, end: int) -> None:
        self.buf = buf
        self.pos = pos
        self.end = end


def decode_binary(meta: Metadata, data: bytes) -> Dict[str, Any]:
    return _decode_record(meta, _Reader(data, 0, len(data)))


def _decode_record(meta: Metadata, r: _Reader) -> Dict[str, Any]:
    by_tag = _fields_by_tag(meta)
    refs = all_refs(meta)  # own + inherited (real inheritance)
    out: Dict[str, Any] = {}
    while r.pos < r.end:
        key = _read_varint(r)
        tag = key >> 3
        wiretype = key & 7
        field = by_tag.get(tag)
        if field is None:
            _skip_value(r, wiretype)
            continue
        if wiretype == WIRE_NULL:
            out[field["name"]] = None
            continue
        out[field["name"]] = _decode_value(r, field["type"], wiretype, refs)
    return out


def _fields_by_tag(meta: Metadata) -> Dict[int, Any]:
    m: Dict[int, Any] = {}
    for i, f in enumerate(all_fields(meta)):  # own + inherited (real inheritance)
        tag = f.get("tag")
        if tag is None:
            tag = i + 1
        m[tag] = f
    return m


def _decode_value(r: _Reader, type_: FieldType, wiretype: int, refs: Optional[Dict[str, Any]]) -> Any:
    kind = type_["kind"]
    if kind == "boolean":
        return _read_varint(r) != 0
    if kind == "integer":
        u = _read_varint(r)
        return u if type_.get("unsigned") else zigzag_decode(u)
    if kind == "bigint":
        return zigzag_decode(_read_varint(r))
    if kind == "dateTime":
        return from_epoch_ms(zigzag_decode(_read_varint(r)))
    if kind == "number":
        if wiretype == WIRE_FIXED32:
            v = struct.unpack_from("<f", r.buf, r.pos)[0]
            r.pos += 4
        else:
            v = struct.unpack_from("<d", r.buf, r.pos)[0]
            r.pos += 8
        return v
    if kind in ("string", "id", "enum", "date", "time", "decimal"):
        return _read_len_bytes(r).decode("utf-8")
    if kind == "bytes":
        return bytes(_read_len_bytes(r))
    if kind in ("embedded", "instance"):
        inner = _read_len_window(r)
        sub = (refs or {}).get(_ref_name(type_))
        sub_meta = _class_meta(sub)
        if sub_meta is None:
            return {}
        return _hydrate(sub, _decode_record(sub_meta, inner))
    if kind == "reference":
        id_type = type_.get("idType")
        if id_type and id_type.get("kind") == "integer":
            u = _read_varint(r)
            return u if id_type.get("unsigned") else zigzag_decode(u)
        return _read_len_bytes(r).decode("utf-8")
    if kind == "array":
        inner = _read_len_window(r)
        count = _read_varint(inner)
        result: List[Any] = []
        for _ in range(count):
            ewt = inner.buf[inner.pos]
            inner.pos += 1
            if ewt == WIRE_NULL:
                result.append(None)
            else:
                result.append(_decode_value(inner, type_["of"], ewt, refs))
        return result
    if kind == "json":
        return _decode_json(_read_len_window(r))
    _skip_value(r, wiretype)
    return None


def _decode_json(r: _Reader) -> Any:
    kind = r.buf[r.pos]
    r.pos += 1
    if kind == _JSON_NULL:
        return None
    if kind == _JSON_FALSE:
        return False
    if kind == _JSON_TRUE:
        return True
    if kind == _JSON_INT:
        return zigzag_decode(_read_varint(r))
    if kind == _JSON_FLOAT:
        v = struct.unpack_from("<d", r.buf, r.pos)[0]
        r.pos += 8
        return v
    if kind == _JSON_STRING:
        return _read_len_bytes(r).decode("utf-8")
    if kind == _JSON_BYTES:
        return bytes(_read_len_bytes(r))
    if kind == _JSON_ARRAY:
        count = _read_varint(r)
        return [_decode_json(r) for _ in range(count)]
    if kind == _JSON_OBJECT:
        count = _read_varint(r)
        obj: Dict[str, Any] = {}
        for _ in range(count):
            k = _read_len_bytes(r).decode("utf-8")
            obj[k] = _decode_json(r)
        return obj
    raise ValueError(f"decode_binary: unknown json kind {kind}")


def _skip_value(r: _Reader, wiretype: int) -> None:
    if wiretype == WIRE_VARINT:
        _read_varint(r)
    elif wiretype == WIRE_FIXED64:
        r.pos += 8
    elif wiretype == WIRE_FIXED32:
        r.pos += 4
    elif wiretype == WIRE_LENGTH:
        n = _read_varint(r)
        r.pos += n
    elif wiretype == WIRE_NULL:
        pass
    else:
        raise ValueError(f"decode_binary: unknown wiretype {wiretype}")


def _read_varint(r: _Reader) -> int:
    result = 0
    shift = 0
    while True:
        byte = r.buf[r.pos]
        r.pos += 1
        result |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            break
        shift += 7
    return result


def _read_len_bytes(r: _Reader) -> bytes:
    n = _read_varint(r)
    b = bytes(r.buf[r.pos : r.pos + n])
    r.pos += n
    return b


def _read_len_window(r: _Reader) -> _Reader:
    n = _read_varint(r)
    start = r.pos
    r.pos += n
    return _Reader(r.buf, start, start + n)


# ── Per-value (no-tag) payload codec — positional RPC service arguments / returns ──
#
# Each service argument and return value is encoded by *its type's payload encoder* with no tag
# key (declared param order carries identity). Length-prefixed/varint payloads stay self-
# delimiting, so the decoder reads them back positionally. `instance` (a live class value) encodes
# like an `embedded` record.


def encode_arg(out: bytearray, type_: FieldType, value: Any, refs: Optional[Dict[str, Any]]) -> None:
    _encode_payload(out, type_, value, refs)


def decode_arg(r: _Reader, type_: FieldType, refs: Optional[Dict[str, Any]]) -> Any:
    return _decode_value(r, type_, _wiretype_of(type_), refs)


def reader(data: bytes) -> _Reader:
    return _Reader(data, 0, len(data))

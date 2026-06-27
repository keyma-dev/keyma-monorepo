"""RPC argument / return marshalling — the encoding-dispatching codec the generated client and
service ``dispatch`` delegate to.

A method is described by its declared params (``[(name, type_dict), ...]``) and its return type
(an IR type dict, or ``None`` for ``void``). Both ends carry these descriptors as inline literals
in the generated code; the host never sees them (it is type- and encoding-agnostic).

- **JSON mode:** args are a plain ``dict`` keyed by param name; each value goes through the
  per-value JSON codec (``serialize_value`` / ``deserialize_value``).
- **Binary mode:** args are positional, concatenated payloads with NO names on the wire, each via
  its type's binary encoder (``encode_arg`` / ``decode_arg``), read back in declared order.
"""

from __future__ import annotations

from typing import Any, List, Optional, Sequence, Tuple

from .binary import decode_arg, encode_arg, reader
from .deserialize import deserialize_value
from .serialize import serialize_value
from .types import Encoding, FieldType

#: A method parameter descriptor: ``(name, ir_type_dict)``.
Param = Tuple[str, FieldType]


def encode_args(encoding: Encoding, params: Sequence[Param], values: Sequence[Any], refs: Any) -> Any:
    if encoding == "binary":
        out = bytearray()
        for (_, type_), value in zip(params, values):
            encode_arg(out, type_, value, refs)
        return bytes(out)
    return {name: serialize_value(value, type_, refs) for (name, type_), value in zip(params, values)}


def decode_args(encoding: Encoding, params: Sequence[Param], payload: Any, refs: Any) -> List[Any]:
    if encoding == "binary":
        r = reader(payload or b"")
        return [decode_arg(r, type_, refs) for (_, type_) in params]
    data = payload or {}
    return [deserialize_value(data.get(name), type_, refs) for (name, type_) in params]


def encode_result(encoding: Encoding, return_type: Optional[FieldType], value: Any, refs: Any) -> Any:
    if return_type is None:
        return b"" if encoding == "binary" else None
    if encoding == "binary":
        out = bytearray()
        encode_arg(out, return_type, value, refs)
        return bytes(out)
    return serialize_value(value, return_type, refs)


def decode_result(encoding: Encoding, return_type: Optional[FieldType], payload: Any, refs: Any) -> Any:
    if return_type is None:
        return None
    if encoding == "binary":
        return decode_arg(reader(payload or b""), return_type, refs)
    return deserialize_value(payload, return_type, refs)

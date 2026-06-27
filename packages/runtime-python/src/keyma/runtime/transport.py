"""The capability-flagged ``Transport`` seam and the slim call envelope.

A transport shuttles a :class:`CallRequest` to a host and returns a :class:`CallResult`. Only the
unary ``invoke`` is built this pass; the capability descriptor RESERVES the streaming flags so the
interface won't need a breaking reshape when streaming lands. Encoding (``json`` | ``binary``) is
transport configuration — both ends agree statically, with NO negotiation; the bound client reads
``transport.encoding`` to marshal arguments."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, Protocol, runtime_checkable

from .types import Encoding


@dataclass(frozen=True)
class TransportCapabilities:
    """What a transport supports. Only ``unary`` is implemented; the stream flags are reserved."""

    unary: bool = True
    server_stream: bool = False
    client_stream: bool = False
    bidi: bool = False


@dataclass
class CallRequest:
    """A single RPC call. ``args`` is the encoded argument payload: ``bytes`` (binary mode) or a
    plain ``dict`` keyed by param name (JSON mode)."""

    service: str
    method: str
    args: Any = None


@dataclass
class CallResult:
    """The slim call envelope: success carries ``data`` (the encoded return payload), failure
    carries ``code`` + ``message``. ``ok`` is the 1-byte discriminator of the binary wire form."""

    ok: bool
    data: Any = None
    code: Optional[str] = None
    message: Optional[str] = None

    @staticmethod
    def success(data: Any) -> "CallResult":
        return CallResult(ok=True, data=data)

    @staticmethod
    def failure(code: str, message: str) -> "CallResult":
        return CallResult(ok=False, code=code, message=message)


@runtime_checkable
class Transport(Protocol):
    """The transport contract a generated client binds to. ``encoding`` and ``capabilities`` are
    static; ``invoke`` is the required unary call."""

    encoding: Encoding
    capabilities: TransportCapabilities

    async def invoke(self, request: CallRequest) -> CallResult: ...

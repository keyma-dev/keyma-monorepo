"""The per-service client base a generated client class extends.

A generated ``UserService(transport)`` subclass binds to a :class:`Transport` and exposes one
``async def`` per method. Each method marshals its arguments (via ``marshal.encode_args`` against
the bound transport's ``encoding``), calls :meth:`_invoke`, and hydrates the return payload. The
base unwraps the envelope and **raises** :class:`KeymaError` on failure — exceptions, not result
objects, cross the call boundary in Python."""

from __future__ import annotations

from typing import Any

from .errors import HANDLER_ERROR, KeymaError
from .transport import CallRequest, Transport
from .types import Encoding


class ServiceClient:
    """Base for generated service clients. Subclasses set ``service_name`` and define the methods."""

    #: The wire service identity — set by the generated subclass.
    service_name: str = ""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    @property
    def _encoding(self) -> Encoding:
        return self._transport.encoding

    async def _invoke(self, method: str, args: Any) -> Any:
        """Send one call; return the encoded return payload or raise the unwrapped error."""
        result = await self._transport.invoke(CallRequest(self.service_name, method, args))
        if not result.ok:
            raise KeymaError(result.code or HANDLER_ERROR, result.message or "RPC call failed", result.details)
        return result.data

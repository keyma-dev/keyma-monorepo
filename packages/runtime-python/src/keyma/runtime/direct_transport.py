"""The in-process direct transport.

``create_direct_transport`` hands a :class:`CallRequest` straight to a :class:`ServiceHost` with no
encode/decode hop — the cheap synchronous path (it ``await``s the host inline). It forwards a
caller-supplied ``ctx``, **default non-system** so the host's visibility gate is genuinely
exercised; pass ``is_system=True`` to opt into system identity (e.g. SSR). The configured
``encoding`` is the one both ends agree on statically."""

from __future__ import annotations

from typing import Optional

from .service_host import ServiceHost
from .transport import CallRequest, CallResult, TransportCapabilities
from .types import Encoding, RequestContext


class DirectTransport:
    """A :class:`Transport` bound to an in-process :class:`ServiceHost`."""

    def __init__(self, host: ServiceHost, ctx: RequestContext, encoding: Encoding) -> None:
        self._host = host
        self._ctx = ctx
        self.encoding: Encoding = encoding
        self.capabilities = TransportCapabilities(unary=True)

    async def invoke(self, request: CallRequest) -> CallResult:
        return await self._host.handle(request, self._ctx, self.encoding)


def create_direct_transport(
    host: ServiceHost,
    *,
    ctx: Optional[RequestContext] = None,
    is_system: bool = False,
    encoding: Encoding = "json",
) -> DirectTransport:
    base_ctx: RequestContext = dict(ctx or {})
    if is_system:
        identity = dict(base_ctx.get("identity") or {})
        identity["isSystem"] = True
        base_ctx["identity"] = identity
    return DirectTransport(host, base_ctx, encoding)

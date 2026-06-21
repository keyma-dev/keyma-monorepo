"""In-process transport — port of ``@keyma/runtime-js`` ``client.ts``.

Hands a request directly to a :class:`KeymaServer`. Useful for tests and for
embedding the server in the same process as the client (e.g. SSR). An optional
``context_factory`` (sync or async) runs per request and supplies a
``RequestContext`` (e.g. identity) to the server and its plugins.
"""

from __future__ import annotations

import inspect
from typing import Any, Awaitable, Callable, Optional, Union

from .protocol import KeymaBatchResponse, KeymaRequest, Transport
from .types import RequestContext

ContextFactory = Callable[[], Union[RequestContext, Awaitable[RequestContext]]]


def create_direct_transport(server: Any, context_factory: Optional[ContextFactory] = None) -> Transport:
    if context_factory is None:

        async def transport(request: KeymaRequest) -> KeymaBatchResponse:
            return await server.handle(request)

        return transport

    async def transport_with_ctx(request: KeymaRequest) -> KeymaBatchResponse:
        context = context_factory()
        if inspect.isawaitable(context):
            context = await context
        return await server.handle(request, context)

    return transport_with_ctx

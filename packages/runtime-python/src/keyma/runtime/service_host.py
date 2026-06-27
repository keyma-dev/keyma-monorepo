"""The slim ``ServiceHost``.

Its entire job: resolve service + method by the plaintext string header → visibility-gate
(probe-resistant: a private service/method reports "not found" unless ``ctx.identity.isSystem``) →
inject the ``RequestContext`` → call the generated ``dispatch(method, payload, ctx, encoding)`` →
wrap the result in the slim ``CallResult`` envelope. It is **type-agnostic and encoding-agnostic**
(it forwards ``encoding`` without interpreting it) and does **no validation**.
"""

from __future__ import annotations

import inspect
from typing import Any, Dict, Optional

from .errors import HANDLER_ERROR, METHOD_NOT_FOUND, SERVICE_NOT_FOUND, KeymaError
from .transport import CallRequest, CallResult
from .types import Encoding, RequestContext


def _is_system(ctx: Optional[RequestContext]) -> bool:
    identity = (ctx or {}).get("identity") if isinstance(ctx, dict) else None
    return bool(identity and identity.get("isSystem"))


class ServiceHost:
    """Registers generated service implementations and dispatches calls to them."""

    def __init__(self) -> None:
        self._services: Dict[str, Any] = {}

    def register(self, service: Any) -> "ServiceHost":
        """Register a service implementation (an instance of a generated ``…Base`` subclass). Its
        wire identity is the generated ``service_name``."""
        name = getattr(service, "service_name", None)
        if not name:
            raise KeymaError(HANDLER_ERROR, "ServiceHost.register: object is not a generated service")
        self._services[name] = service
        return self

    async def handle(
        self,
        request: CallRequest,
        ctx: Optional[RequestContext] = None,
        encoding: Encoding = "json",
    ) -> CallResult:
        is_system = _is_system(ctx)

        service = self._services.get(request.service)
        # Probe-resistant: an unknown OR gated-private service reports the same "not found".
        if service is None or (getattr(service, "service_private", False) and not is_system):
            return CallResult.failure(SERVICE_NOT_FOUND, f"Service '{request.service}' not found")

        method_meta = getattr(service, "_methods", {}).get(request.method)
        if method_meta is None or (method_meta.get("private") and not is_system):
            return CallResult.failure(METHOD_NOT_FOUND, f"Method '{request.method}' not found")

        try:
            result = service.dispatch(request.method, request.args, ctx, encoding)
            if inspect.isawaitable(result):
                result = await result
        except KeymaError as e:
            return CallResult.failure(e.code, e.message)
        except Exception as e:  # noqa: BLE001 - any handler error collapses to one envelope code
            return CallResult.failure(HANDLER_ERROR, str(e))

        return CallResult.success(result)

"""The single RPC error model.

The query/adapter/plugin taxonomy is gone; one :class:`KeymaError` ``{code, message}`` carries
every failure. The host wraps a failed call into the ``CallResult`` envelope with one of the
codes below; the generated client unwraps the envelope and **raises** ``KeymaError``. Transports
own their own connection/transport codes on top of these.
"""

from __future__ import annotations

# ── Canonical error codes (host-owned) ─────────────────────────────────────────
SERVICE_NOT_FOUND = "SERVICE_NOT_FOUND"
METHOD_NOT_FOUND = "METHOD_NOT_FOUND"
METHOD_NOT_IMPLEMENTED = "METHOD_NOT_IMPLEMENTED"
HANDLER_ERROR = "HANDLER_ERROR"


class KeymaError(Exception):
    """A structured RPC error: a stable ``code`` plus a human ``message``."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"KeymaError(code={self.code!r}, message={self.message!r})"

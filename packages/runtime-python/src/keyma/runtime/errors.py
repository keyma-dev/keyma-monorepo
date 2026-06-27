"""The single RPC error model.

The query/adapter/plugin taxonomy is gone; one :class:`KeymaError` ``{code, message}`` carries
every failure. The host wraps a failed call into the ``CallResult`` envelope with one of the
codes below; the generated client unwraps the envelope and **raises** ``KeymaError``. Transports
own their own connection/transport codes on top of these.
"""

from __future__ import annotations

from typing import Any, Optional

# ── Canonical error codes (host-owned) ─────────────────────────────────────────
SERVICE_NOT_FOUND = "SERVICE_NOT_FOUND"
METHOD_NOT_FOUND = "METHOD_NOT_FOUND"
METHOD_NOT_IMPLEMENTED = "METHOD_NOT_IMPLEMENTED"
HANDLER_ERROR = "HANDLER_ERROR"
# Conventional code an impl raises (carrying structured ``details``) after an opt-in
# ``validate(Model.metadata, arg)`` rejects an inbound model argument.
VALIDATION_ERROR = "VALIDATION_ERROR"


class KeymaError(Exception):
    """A structured RPC error: a stable ``code`` plus a human ``message``, and an optional
    code-specific ``details`` payload (e.g. a ``ValidationError[]`` for ``VALIDATION_ERROR``).
    ``details`` is domain-neutral — the RPC stack never inspects it; the host folds it into the
    failure envelope and the generated client re-raises it."""

    def __init__(self, code: str, message: str, details: Optional[Any] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"KeymaError(code={self.code!r}, message={self.message!r})"

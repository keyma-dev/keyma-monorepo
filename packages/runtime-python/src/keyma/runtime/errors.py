"""Structured error model mirroring ``@keyma/runtime-js`` ``errors.ts``.

Raising any :class:`KeymaError` subclass from a plugin or adapter produces a
structured ``KeymaLeafFailure`` on the wire (see ``server.error_to_result``).
"""

from __future__ import annotations

from typing import Any, Dict

ErrorSource = str  # Literal["runtime", "plugin", "adapter"]


class KeymaError(Exception):
    """Base for runtime/plugin/adapter errors. Subclasses set ``code``/``source``/
    ``origin`` and may override :meth:`to_failure_extras` to merge extra fields into
    the wire failure (e.g. ``{"errors": [...]}``)."""

    code: str = ""
    source: ErrorSource = "runtime"
    #: Package name of the originator, e.g. "keyma-plugin-acl". Empty for runtime.
    origin: str = ""

    def to_failure_extras(self) -> Dict[str, Any]:
        return {}


class KeymaRuntimeError(KeymaError):
    source = "runtime"
    origin = ""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class KeymaPluginError(KeymaError):
    source = "plugin"

    def __init__(self, code: str, message: str, origin: str, extras: "Dict[str, Any] | None" = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.origin = origin
        self._extras = extras or {}

    def to_failure_extras(self) -> Dict[str, Any]:
        return self._extras


class KeymaAdapterError(KeymaError):
    source = "adapter"

    def __init__(self, code: str, message: str, origin: str, extras: "Dict[str, Any] | None" = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.origin = origin
        self._extras = extras or {}

    def to_failure_extras(self) -> Dict[str, Any]:
        return self._extras


def is_plugin_failure(r: Dict[str, Any]) -> bool:
    return r.get("source") == "plugin"


def is_adapter_failure(r: Dict[str, Any]) -> bool:
    return r.get("source") == "adapter"


def is_runtime_failure(r: Dict[str, Any]) -> bool:
    return r.get("source") == "runtime"

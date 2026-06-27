"""Low-level helpers shared by the codec (``serialize`` / ``deserialize`` / ``binary``).

These live in one place so the baked bundle-local module defines them exactly once. The codec
is **target-free and visibility-blind** (the cross-language RPC rewrite dropped the
``SerializeTarget`` notion): private-field exclusion is purely the compile-time bundle split,
and ``@Ephemeral`` is a serialization no-op. Field identity, conversions, and recursion are all
target-agnostic.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

#: A class-metadata dict (the value attached to a generated class as ``Class.metadata``).
Metadata = Dict[str, Any]


def _read(obj: Any, name: str) -> Tuple[bool, Any]:
    """Return ``(present, value)`` for ``name`` on a dict or an object instance."""
    if isinstance(obj, dict):
        return (name in obj, obj.get(name))
    if hasattr(obj, name):
        return (True, getattr(obj, name))
    return (False, None)


def _is_record(value: Any) -> bool:
    return isinstance(value, dict) or (
        hasattr(value, "__dict__") and not isinstance(value, (list, str, bytes, bytearray))
    )


def _class_meta(cls: Any) -> Optional[Metadata]:
    """The metadata dict of a referenced class. Generated classes carry it as ``.metadata``
    (the cross-language contract); a bare dict is accepted verbatim."""
    if cls is None:
        return None
    if isinstance(cls, dict):
        return cls
    return getattr(cls, "metadata", None)


def _ref_name(type_: Dict[str, Any]) -> Optional[str]:
    """The target class identity a ``reference``/``embedded``/``instance`` type points at.

    The IR (and generated metadata) keys this as ``target`` for reference/embedded and ``name``
    for ``instance``; the legacy ``schema`` key is accepted as a fallback for cross-runtime
    fixture compatibility."""
    return type_.get("target") or type_.get("name") or type_.get("schema")


def _hydrate(cls: Any, value: Dict[str, Any]) -> Any:
    """Construct an instance of ``cls`` from a decoded record dict. Generated classes expose a
    static ``from_value`` factory (008); a plain callable class is invoked directly."""
    factory = getattr(cls, "from_value", None)
    if factory is not None:
        return factory(value)
    return cls(value)

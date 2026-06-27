"""Validator/formatter invocation context + a synchronous, arity-adaptive caller.

The schema backend re-emits each validator/formatter as a factory closure whose inner
function declares only as many positional parameters as the authored body uses, e.g.
``def _v(value, field): ...`` (2 params) or ``def _f(value): ...`` (1 param) — see
``packages/schema/src/backend-python/emit-validators.ts``. The JS runtime always passes the
full argument list and relies on JS silently dropping surplus arguments; Python raises
``TypeError`` on extra positionals, so :func:`invoke` truncates the argument tuple to each
callable's real positional arity.

Unlike the deleted ``_invoke`` module this is **synchronous**: async validators/formatters are
rejected at the frontend (KEYMA026), so the drivers never await. ``ctx.object`` carries the whole
record dict, mirroring the JS ``ValidatorContext``/``FormatterContext`` shape so a lowered
``ctx.object.get("field")`` cross-field access resolves.
"""

from __future__ import annotations

import inspect
from typing import Any, Callable, Optional, Sequence


class Context:
    """The ``{ object }`` context handed to validators/formatters.

    Exposes the whole record (a plain ``dict``) under attribute ``.object`` so a lowered
    ``ctx.object.get("<field>")`` cross-field access resolves.
    """

    __slots__ = ("object",)

    def __init__(self, obj: Any) -> None:
        self.object = obj


_UNSET = object()
_arity_cache: "dict[Any, Optional[int]]" = {}


def _positional_arity(fn: Any) -> Optional[int]:
    """Number of positional parameters ``fn`` accepts, or ``None`` for "any" (``*args``
    present, or the signature cannot be introspected)."""
    cached = _arity_cache.get(fn, _UNSET)
    if cached is not _UNSET:
        return cached  # type: ignore[return-value]
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        _arity_cache[fn] = None
        return None
    n = 0
    for p in sig.parameters.values():
        if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD):
            n += 1
        elif p.kind == inspect.Parameter.VAR_POSITIONAL:
            _arity_cache[fn] = None
            return None
    _arity_cache[fn] = n
    return n


def invoke(fn: Callable[..., Any], args: Sequence[Any]) -> Any:
    """Call ``fn`` with at most as many positional ``args`` as it declares, returning its
    result. Surplus trailing args are dropped (the JS runtime relies on JS ignoring them);
    a ``*args`` / un-introspectable callable receives the full tuple."""
    arity = _positional_arity(fn)
    if arity is not None and arity < len(args):
        args = args[:arity]
    return fn(*args)

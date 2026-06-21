"""Arity-adaptive invocation of generated validator/formatter callables.

The Keyma Python backend emits validators/formatters as factory closures whose
inner function declares only as many parameters as the authored body uses, e.g.
``def _v(raw, field): ...`` (2 params) or ``def _f(value): ...`` (1 param). The
JavaScript runtime always passes the full argument list and relies on JS silently
ignoring extra arguments; Python raises ``TypeError`` on surplus positional args,
so we truncate the argument tuple to each callable's real positional arity.

Bodies may be synchronous (today's generated output) or asynchronous (hand-authored
or future generators); ``invoke_adaptive`` awaits the result when it is awaitable,
mirroring runtime-js where every validator/formatter call is ``await``-ed.
"""

from __future__ import annotations

import inspect
from typing import Any, Optional, Sequence


class Context:
    """The ``{ object }`` context handed to validators/formatters.

    Exposes the whole record under attribute ``.object`` (mirroring the JS
    ``ValidatorContext``/``FormatterContext`` shape) so a lowered ``ctx.object``
    cross-field access resolves.
    """

    __slots__ = ("object",)

    def __init__(self, obj: Any) -> None:
        self.object = obj


_UNSET = object()
_arity_cache: "dict[Any, Optional[int]]" = {}


def _positional_arity(fn: Any) -> Optional[int]:
    """Number of positional parameters ``fn`` accepts, or ``None`` for "any"
    (``*args`` present, or the signature cannot be introspected)."""
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


async def invoke_adaptive(fn: Any, args: Sequence[Any]) -> Any:
    """Call ``fn`` with ``args`` truncated to its positional arity, awaiting an
    awaitable result. Reproduces JS "extra args ignored" semantics in Python."""
    n = _positional_arity(fn)
    call_args = args if n is None else args[:n]
    result = fn(*call_args)
    if inspect.isawaitable(result):
        result = await result
    return result

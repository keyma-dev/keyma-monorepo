"""JS-semantics intrinsic helpers referenced by generated Python expression code.

The Keyma TypeScript→Python lowering reproduces a small set of JS built-ins whose
behaviour differs from Python's: ``String(x)`` / ``Number(x)`` coercion and the
``Math.round`` / ``Math.trunc`` / ``Math.sign`` numerics (half-up rounding, NaN /
Infinity pass-through, signed zero). Generated modules ``from keyma.runtime import``
only the helpers they actually use; the remaining Math ops lower to the stdlib ``math``
module or builtins directly.
"""

from __future__ import annotations

import math as _math
from typing import Any, Union

Number = Union[int, float]


def _js_float_str(x: float) -> str:
    """A float's JS string form: integral floats print without a trailing ``.0``."""
    if x != x:
        return "NaN"
    if x == _math.inf:
        return "Infinity"
    if x == -_math.inf:
        return "-Infinity"
    if x.is_integer():
        return str(int(x))
    return repr(x)


def to_string(value: Any) -> str:
    """JS ``String(value)`` — coerce any value to its JS string form."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return value
    if isinstance(value, float):
        return _js_float_str(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, (list, tuple)):
        return ",".join("" if v is None else to_string(v) for v in value)
    if isinstance(value, dict):
        return "[object Object]"
    return str(value)


def to_number(value: Any) -> Number:
    """JS ``Number(value)`` — coerce any value to a JS number (``nan`` when non-numeric)."""
    if value is None:
        return 0
    if value is True:
        return 1
    if value is False:
        return 0
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        s = value.strip()
        if s == "":
            return 0
        low = s.lower()
        try:
            if low.startswith("0x"):
                return int(s, 16)
            if low.startswith("0b"):
                return int(s, 2)
            if low.startswith("0o"):
                return int(s, 8)
            return int(s)
        except ValueError:
            try:
                return float(s)
            except ValueError:
                return _math.nan
    if isinstance(value, (list, tuple)):
        if len(value) == 0:
            return 0
        if len(value) == 1:
            return to_number(value[0])
        return _math.nan
    return _math.nan


def math_round(x: float) -> Number:
    """JS ``Math.round`` — round half toward +Infinity (not Python's banker's rounding)."""
    if x != x or x == _math.inf or x == -_math.inf:
        return x
    return _math.floor(x + 0.5)


def math_trunc(x: float) -> Number:
    """JS ``Math.trunc`` — truncate toward zero; NaN / ±Infinity pass through."""
    if x != x or x == _math.inf or x == -_math.inf:
        return x
    return _math.trunc(x)


def math_sign(x: float) -> Number:
    """JS ``Math.sign`` — -1, 0 or 1 (NaN passes through; preserves signed zero)."""
    if x != x:
        return x
    if x > 0:
        return 1
    if x < 0:
        return -1
    return x

"""Date wire helpers for ``dateTime`` serialization.

``to_epoch_ms`` / ``from_epoch_ms`` are the canonical cross-runtime wire format: an
epoch-millisecond ``int`` byte-compatible with the JavaScript runtime's
``Date.getTime()`` / ``new Date(ms)`` and the C++ runtime's epoch-ms ``int64``.

``to_iso`` / ``from_iso`` remain available for ISO-8601 string interop (e.g. the
``date.toISOString()`` body intrinsic and application-level defaults); they always emit
UTC with millisecond precision and a trailing ``Z`` (e.g. ``"2024-01-02T03:04:05.000Z"``).
"""

from __future__ import annotations

from datetime import datetime, timezone


def to_epoch_ms(dt: datetime) -> int:
    """Epoch milliseconds (int64), mirroring JS ``Date.prototype.getTime``.

    Naive datetimes are assumed UTC and normalized BEFORE ``timestamp()`` (which would
    otherwise interpret a naive value as LOCAL time, yielding a different instant)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return round(dt.timestamp() * 1000)


def from_epoch_ms(value: float) -> datetime:
    """Inverse of :func:`to_epoch_ms` / JS ``new Date(ms)`` — a timezone-aware UTC datetime."""
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc)


def to_iso(dt: datetime) -> str:
    """Mirror JS ``Date.prototype.toISOString``: UTC, milliseconds, trailing ``Z``.

    Naive datetimes are assumed UTC (matching how a naive value would be treated
    once it crosses the wire as UTC)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def from_iso(value: str) -> datetime:
    """Parse an ISO-8601 string (including the JS ``Z`` suffix) into a
    timezone-aware :class:`datetime`."""
    return datetime.fromisoformat(value.replace("Z", "+00:00"))

"""ISO-8601 helpers for ``dateTime`` serialization, kept byte-compatible with the
JavaScript runtime's ``Date.toISOString()`` / ``new Date(str)`` round-trip.

``to_iso`` always emits UTC with millisecond precision and a trailing ``Z`` (e.g.
``"2024-01-02T03:04:05.000Z"``), exactly what a JS client produces and expects.
``from_iso`` accepts that form (and any ISO offset) on Python 3.9+.
"""

from __future__ import annotations

from datetime import datetime, timezone


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

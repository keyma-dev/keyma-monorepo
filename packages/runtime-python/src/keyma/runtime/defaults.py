"""Default application — port of ``@keyma/runtime-js`` ``defaults.ts``."""

from __future__ import annotations

from typing import Any, Dict

from .types import SchemaMetadata


def apply_defaults(schema: SchemaMetadata, data: Dict[str, Any]) -> Dict[str, Any]:
    """Apply field defaults to a create payload, filling only keys that are absent
    (or ``None``). Literal defaults are read from the metadata; list defaults are
    shallow-copied so instances never share state. Expression-kind defaults are
    applied by the schema's own ``applyDefaults`` function (re-emitted runnable code
    attached to the metadata, which guards its own absent check). Mutates and
    returns ``data``.
    """
    for field in schema["fields"]:
        default = field.get("default")
        if default is None:
            continue
        name = field["name"]
        # JS guards `name in data && data[name] !== undefined`; JSON payloads never
        # carry `undefined`, so a present key (even an explicit null) is "provided"
        # and keeps its value. Expression defaults (the schema's applyDefaults) run
        # below and apply their own None guard.
        if name in data:
            continue
        if default.get("kind") == "literal":
            value = default.get("value")
            data[name] = list(value) if isinstance(value, list) else value
        # `expression` defaults are applied by the schema's applyDefaults below.

    apply = schema.get("applyDefaults")
    if apply is not None:
        apply(data)
    return data

"""Attach generated metadata statics to a plain class — port of ``brand.ts``.

Generated model/service classes carry their metadata as a class attribute
(``Class.schema`` / ``Class.service``). These helpers attach the same statics to a
hand-written class, used by tests and codegen fallback."""

from __future__ import annotations

from typing import Any

from .types import SchemaMetadata, ServiceMetadata


def brand_schema(cls: Any, schema: SchemaMetadata) -> Any:
    """Brand a plain class with :class:`SchemaMetadata` (as ``cls.schema``)."""
    cls.schema = schema
    return cls


def brand_service(cls: Any, service: ServiceMetadata) -> Any:
    """Brand a plain class with :class:`ServiceMetadata` (as ``cls.service``)."""
    cls.service = service
    return cls

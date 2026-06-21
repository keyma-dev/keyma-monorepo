"""Materializer application — port of ``@keyma/runtime-js`` ``materialize.ts``.

Each materializer is a module-level function emitted by the backend
(``def materializeX(value: dict) -> dict``) that fills computed fields by mutating
the record in place."""

from __future__ import annotations

from typing import Any, Dict, Iterable

from .types import MaterializerFn


def apply_materializers(materializers: "Iterable[MaterializerFn]", value: Dict[str, Any]) -> None:
    for mat in materializers:
        mat(value)

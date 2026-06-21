"""Database-adapter interface — port of ``@keyma/runtime-js`` ``adapter.ts``.

A :class:`KeymaDatabaseAdapter` implements seven required async methods —
``ensure_schema``, ``create``, ``read``, ``list``, ``update``, ``delete``,
``count`` — and may add the optional ``traverse``, ``connect``, ``close`` and a
``capabilities`` descriptor. ``KeymaServer`` duck-types the optional members.
(``list``/``delete`` are valid as method attributes; they do not shadow the
built-ins.)

Filter (``where``) shape — identical on every method and inside a ``TraversalSpec``:

- Top-level keys are field names of the operation's schema (``id`` is a reserved
  alias the adapter may map to its native primary key).
- Field values are literals (equality) or operator objects using ``$eq`` / ``$ne``
  / ``$gt`` / ``$gte`` / ``$lt`` / ``$lte`` / ``$in`` / ``$nin``.
- Top-level keys ``$and`` / ``$or`` / ``$nor`` carry an array of sub-filters of the
  same shape (server plugins inject these; adapters must handle them).
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Protocol, TypedDict, Union, runtime_checkable

from .protocol import TraversalSpec
from .types import SchemaMetadata

#: ``1`` = include scalar/reference-as-id/embedded-as-whole; dict = embedded sub-fields.
AdapterFieldSpec = Union[int, Dict[str, Any]]


class PopulateNode(TypedDict, total=False):
    schema: SchemaMetadata
    projection: "AdapterProjection"


PopulateSpec = Dict[str, PopulateNode]


class AdapterProjection(TypedDict, total=False):
    fields: Dict[str, AdapterFieldSpec]
    populate: PopulateSpec


class ListQuery(TypedDict, total=False):
    where: Dict[str, Any]
    sort: Dict[str, int]
    skip: int
    limit: int
    projection: AdapterProjection


class AdapterTraverseCapability(TypedDict, total=False):
    maxDepth: int
    emitPaths: bool
    heterogeneous: bool


class AdapterCapabilities(TypedDict, total=False):
    traverse: Union[bool, AdapterTraverseCapability]


#: ``[node...]`` for emit "nodes"/"edges"; ``[{"nodes": [...], "edges": [...]}...]`` for "paths".
AdapterTraversalResult = Union[
    List[Dict[str, Any]],
    List[Dict[str, Any]],  # list of {"nodes": [...], "edges": [...]}
]


class AdapterTraversalContext(TypedDict):
    terminalSchema: SchemaMetadata
    startSchema: SchemaMetadata
    edges: Mapping[str, SchemaMetadata]
    nodes: Mapping[str, SchemaMetadata]


@runtime_checkable
class KeymaDatabaseAdapter(Protocol):
    """Structural interface consumed by :class:`KeymaServer`. Implementations need
    not inherit from this Protocol. Optional members (``capabilities``, ``connect``,
    ``close``, ``traverse``) are duck-typed by the server."""

    async def ensure_schema(self, schema: SchemaMetadata) -> None: ...

    async def create(
        self, schema: SchemaMetadata, data: Dict[str, Any], projection: "Optional[AdapterProjection]" = None
    ) -> Dict[str, Any]: ...

    async def read(
        self, schema: SchemaMetadata, where: Dict[str, Any], projection: "Optional[AdapterProjection]" = None
    ) -> Optional[Dict[str, Any]]: ...

    async def list(self, schema: SchemaMetadata, query: ListQuery) -> List[Dict[str, Any]]: ...

    async def update(
        self,
        schema: SchemaMetadata,
        where: Dict[str, Any],
        data: Dict[str, Any],
        projection: "Optional[AdapterProjection]" = None,
    ) -> Dict[str, Any]: ...

    async def delete(self, schema: SchemaMetadata, where: Dict[str, Any]) -> None: ...

    async def count(self, schema: SchemaMetadata, where: Optional[Dict[str, Any]] = None) -> int: ...

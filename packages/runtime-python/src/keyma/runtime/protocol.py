"""Wire protocol — port of ``@keyma/runtime-js`` ``protocol.ts``.

Operations, requests and responses travel as plain dicts (the cross-language wire
format). The ``TypedDict`` definitions here document their shape; the runtime builds
and reads dicts directly.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, List, Literal, Optional, TypedDict, Union

from .types import ValidationError

ProjectionSpec = Dict[str, Any]  # { field: 1 | ProjectionSpec }


class ListOptions(TypedDict, total=False):
    skip: int
    limit: int
    sort: Dict[str, int]  # field -> 1 | -1


TraversalDirection = Literal["out", "in", "both"]
TraversalEmit = Literal["nodes", "edges", "paths"]


class TraversalStep(TypedDict, total=False):
    via: str  # edge schema name
    direction: TraversalDirection
    edgeWhere: Dict[str, Any]
    nodeWhere: Dict[str, Any]


class TraversalStart(TypedDict):
    schema: str
    where: Dict[str, Any]


class TraversalDepth(TypedDict, total=False):
    min: int
    max: int


class TraversalSpec(TypedDict, total=False):
    start: TraversalStart
    steps: List[TraversalStep]
    repeat: TraversalStep
    depth: TraversalDepth
    where: Dict[str, Any]
    emit: TraversalEmit
    options: ListOptions


#: A single operation in a batch — discriminated on ``op``. Runtime value is a dict.
KeymaOperation = Dict[str, Any]


class KeymaRequest(TypedDict):
    operations: Dict[str, KeymaOperation]


class KeymaLeafSuccess(TypedDict):
    ok: Literal[True]
    data: Any


class KeymaLeafFailure(TypedDict, total=False):
    ok: Literal[False]
    error: str
    code: str
    source: str  # ErrorSource
    origin: str
    errors: List[ValidationError]


KeymaLeafResult = Dict[str, Any]  # KeymaLeafSuccess | KeymaLeafFailure


class KeymaBatchResponse(TypedDict):
    results: Dict[str, KeymaLeafResult]


#: Async transport: ``async (request) -> response``.
Transport = Callable[[KeymaRequest], Awaitable[KeymaBatchResponse]]

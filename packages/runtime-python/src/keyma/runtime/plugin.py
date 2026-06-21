"""Server-plugin protocol — port of ``@keyma/runtime-js`` ``plugin.ts``.

Plugins are duck-typed: a plugin is any object with a ``name`` attribute and any
subset of the optional hook methods below. Hook methods use **snake_case** (Pythonic,
consistent with the rest of the runtime API): ``init``, ``transform_operation``,
``before_operation``, ``transform_filter``, ``transform_projection``,
``check_write``, ``transform_result``, ``after_operation``. Hooks may be sync or
async; the server awaits awaitable results.

Hooks fire in plugin order at well-defined points; ``transform_operation`` runs
first and can rewrite the whole operation (so a plugin can inject read predicates
into traversals, which never run ``transform_filter``).
"""

from __future__ import annotations

from typing import Any, Awaitable, Dict, List, Literal, Optional, Protocol, Sequence, Union, runtime_checkable

from .adapter import AdapterProjection, KeymaDatabaseAdapter
from .protocol import KeymaLeafResult, KeymaOperation
from .types import RequestContext, SchemaMetadata

KeymaReadAction = Literal["read", "list", "traverse", "count"]
KeymaWriteAction = Literal["create", "update", "delete"]
KeymaAction = Union[KeymaReadAction, KeymaWriteAction]


@runtime_checkable
class PluginServerHandle(Protocol):
    """Subset of :class:`KeymaServer` that plugins may call during ``init``."""

    @property
    def schemas(self) -> Sequence[SchemaMetadata]: ...

    @property
    def adapter(self) -> KeymaDatabaseAdapter: ...

    def schema(self, name: str) -> Optional[SchemaMetadata]: ...

    def add_schema(self, schema: SchemaMetadata) -> Any: ...


class KeymaServerPlugin(Protocol):
    """Documents the full plugin surface. A real plugin implements ``name`` plus any
    subset of the hooks; the server reads each hook via ``getattr``."""

    name: str

    # Each of the following is OPTIONAL on a concrete plugin (do not declare what you
    # do not implement). Signatures shown for reference:
    #
    #   def init(self, server: PluginServerHandle) -> Awaitable[None] | None
    #   def transform_operation(self, ctx, op) -> KeymaOperation | None | Awaitable[...]
    #   def before_operation(self, ctx, op) -> Awaitable[None] | None
    #   def transform_filter(self, ctx, schema, where, action) -> dict | None | Awaitable[...]
    #   def transform_projection(self, ctx, schema, projection, action) -> AdapterProjection | None | Awaitable[...]
    #   def check_write(self, ctx, schema, data, action) -> dict | None | Awaitable[...]
    #   def transform_result(self, ctx, schema, records, action) -> list[dict] | None | Awaitable[...]
    #   def after_operation(self, ctx, op, result) -> Awaitable[None] | None

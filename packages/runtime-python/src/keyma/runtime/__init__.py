"""keyma.runtime — Python target runtime for Keyma.

Python sibling of ``@keyma/runtime-js``: validates, formats, serializes and
deserializes records against the schema metadata emitted by
``@keyma/compiler-backend-python``, runs a :class:`KeymaServer` over a pluggable
database adapter, and exposes the :class:`Keyma` query builder plus an in-process
transport.

Beyond the standard library this package has zero dependencies. Testing utilities
(``InMemoryAdapter``, ``matches``, ``matches_op``, ``brand_schema``, ``brand_service``)
live in :mod:`keyma.runtime.testing`.
"""

from __future__ import annotations

__version__ = "0.1.0"

# ── Schema metadata types ─────────────────────────────────────────────────────
from .types import (
    EdgeMetadata,
    FieldMetadata,
    FieldType,
    RequestContext,
    SchemaMetadata,
    SerializeTarget,
    ServiceMetadata,
    ServiceMethodMetadata,
    ServiceParamMetadata,
    ValidationError,
)

# ── Data transforms ───────────────────────────────────────────────────────────
from .validate import validate
from .format import format
from .defaults import apply_defaults
from .serialize import serialize
from .deserialize import deserialize
from .binary import encode_binary, decode_binary

# ── Errors ─────────────────────────────────────────────────────────────────────
from .errors import (
    ErrorSource,
    KeymaAdapterError,
    KeymaError,
    KeymaPluginError,
    KeymaRuntimeError,
    is_adapter_failure,
    is_plugin_failure,
    is_runtime_failure,
)

# ── Protocol / adapter / plugin types ─────────────────────────────────────────
from .protocol import (
    KeymaBatchResponse,
    KeymaLeafFailure,
    KeymaLeafResult,
    KeymaLeafSuccess,
    KeymaOperation,
    KeymaRequest,
    ListOptions,
    ProjectionSpec,
    Transport,
    TraversalDirection,
    TraversalEmit,
    TraversalSpec,
    TraversalStep,
)
from .adapter import (
    AdapterCapabilities,
    AdapterFieldSpec,
    AdapterProjection,
    AdapterTraversalContext,
    KeymaDatabaseAdapter,
    ListQuery,
    PopulateNode,
    PopulateSpec,
)
from .plugin import (
    KeymaAction,
    KeymaReadAction,
    KeymaServerPlugin,
    KeymaWriteAction,
    PluginServerHandle,
)

# ── Server, transport, query builder ──────────────────────────────────────────
from .server import KeymaServer
from .client import create_direct_transport
from .query import Input, Keyma

# ── Intrinsic helpers (referenced by generated expression code) ───────────────
from .intrinsics import (
    math_round,
    math_sign,
    math_trunc,
    to_number,
    to_string,
)

__all__ = [
    "__version__",
    # intrinsic helpers
    "to_string",
    "to_number",
    "math_round",
    "math_trunc",
    "math_sign",
    # data transforms
    "validate",
    "format",
    "apply_defaults",
    "serialize",
    "deserialize",
    "encode_binary",
    "decode_binary",
    # metadata types
    "SchemaMetadata",
    "FieldMetadata",
    "FieldType",
    "EdgeMetadata",
    "ValidationError",
    "SerializeTarget",
    "RequestContext",
    "ServiceMetadata",
    "ServiceMethodMetadata",
    "ServiceParamMetadata",
    # errors
    "KeymaError",
    "KeymaRuntimeError",
    "KeymaPluginError",
    "KeymaAdapterError",
    "ErrorSource",
    "is_plugin_failure",
    "is_adapter_failure",
    "is_runtime_failure",
    # protocol
    "KeymaOperation",
    "KeymaRequest",
    "KeymaBatchResponse",
    "KeymaLeafResult",
    "KeymaLeafSuccess",
    "KeymaLeafFailure",
    "ProjectionSpec",
    "ListOptions",
    "Transport",
    "TraversalSpec",
    "TraversalStep",
    "TraversalDirection",
    "TraversalEmit",
    # adapter
    "KeymaDatabaseAdapter",
    "ListQuery",
    "AdapterProjection",
    "AdapterFieldSpec",
    "PopulateSpec",
    "PopulateNode",
    "AdapterCapabilities",
    "AdapterTraversalContext",
    # plugin
    "KeymaServerPlugin",
    "PluginServerHandle",
    "KeymaAction",
    "KeymaReadAction",
    "KeymaWriteAction",
    # server / transport / query
    "KeymaServer",
    "create_direct_transport",
    "Keyma",
    "Input",
]

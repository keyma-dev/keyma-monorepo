"""keyma.runtime — Python target runtime for Keyma (RPC).

The authored source-of-truth + isolated test bed for the Python codec and RPC stack. The compiler
BAKES these modules into self-contained generated bundles; generated code never imports this
package. Two halves:

- **Codec** (target-free + visibility-blind): ``serialize`` / ``deserialize`` (JSON) and
  ``encode_binary`` / ``decode_binary`` (binary), byte-identical to the JS / C++ runtimes.
- **RPC stack**: a slim ``ServiceHost``, a capability-flagged ``Transport`` with the
  ``CallRequest`` / ``CallResult`` envelope, an in-process ``create_direct_transport``, and the
  ``ServiceClient`` base + ``marshal`` argument codec the generated client/service delegate to.

Beyond the standard library this package has zero dependencies.
"""

from __future__ import annotations

__version__ = "0.1.0"

# ── Codec ──────────────────────────────────────────────────────────────────────
from .serialize import serialize, serialize_value
from .deserialize import deserialize, deserialize_value
from .binary import encode_binary, decode_binary, encode_arg, decode_arg, reader
from .fields import all_fields, all_refs

# ── Validation / formatting / defaults drivers ─────────────────────────────────
from .schema_fields import all_schema_fields
from .validate import validate, ValidationError
from .format import format
from .defaults import apply_defaults

# ── Errors ─────────────────────────────────────────────────────────────────────
from .errors import (
    KeymaError,
    SERVICE_NOT_FOUND,
    METHOD_NOT_FOUND,
    METHOD_NOT_IMPLEMENTED,
    HANDLER_ERROR,
    VALIDATION_ERROR,
)

# ── RPC stack ──────────────────────────────────────────────────────────────────
from .transport import (
    CallRequest,
    CallResult,
    Transport,
    TransportCapabilities,
)
from .service_host import ServiceHost
from .direct_transport import DirectTransport, create_direct_transport
from .client import ServiceClient
from .marshal import encode_args, decode_args, encode_result, decode_result

# ── Metadata / RPC type aliases ────────────────────────────────────────────────
from .types import Encoding, FieldType, RequestContext

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
    # codec
    "serialize",
    "serialize_value",
    "deserialize",
    "deserialize_value",
    "encode_binary",
    "decode_binary",
    "encode_arg",
    "decode_arg",
    "reader",
    "all_fields",
    "all_refs",
    # validation / formatting / defaults
    "all_schema_fields",
    "validate",
    "ValidationError",
    "format",
    "apply_defaults",
    # errors
    "KeymaError",
    "SERVICE_NOT_FOUND",
    "METHOD_NOT_FOUND",
    "METHOD_NOT_IMPLEMENTED",
    "HANDLER_ERROR",
    "VALIDATION_ERROR",
    # rpc stack
    "CallRequest",
    "CallResult",
    "Transport",
    "TransportCapabilities",
    "ServiceHost",
    "DirectTransport",
    "create_direct_transport",
    "ServiceClient",
    "encode_args",
    "decode_args",
    "encode_result",
    "decode_result",
    # type aliases
    "Encoding",
    "FieldType",
    "RequestContext",
    # intrinsic helpers
    "to_string",
    "to_number",
    "math_round",
    "math_trunc",
    "math_sign",
]

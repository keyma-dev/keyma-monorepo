"""Runtime schema-metadata types — the Python view of the metadata dict emitted by
``@keyma/compiler-backend-python`` and attached to each generated class as
``Class.schema``.

The metadata is a plain ``dict`` with **camelCase** keys (the cross-language
contract, matching the IR and the JS runtime); only the Python *API* is snake_case.
These ``TypedDict``/alias definitions exist for documentation and type-checking —
the runtime reads dicts directly, so every key is optional in practice.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, List, Literal, Optional, TypedDict, Union

SerializeTarget = Literal["client", "server", "database"]
Visibility = Literal["public", "private"]

#: A field type node, e.g. ``{"kind": "string"}`` or ``{"kind": "array", "of": {...}}``.
#: See ``@keyma/ir`` for the authoritative union.
FieldType = Dict[str, Any]


class ValidationError(TypedDict):
    field: str
    code: str
    message: str


#: Context object handed to validators/formatters; exposes ``.object`` (the record).
ValidatorContext = Any
FormatterContext = Any

# Validators/formatters are factory-built callables re-emitted into the metadata.
# Inner arity varies (the runtime adapts the call) and bodies may be sync or async;
# these aliases describe the maximal signature.
ValidatorFn = Callable[..., Union[Optional[ValidationError], Awaitable[Optional[ValidationError]]]]
FormatterFn = Callable[..., Any]
SchemaDefaultsFn = Callable[[Dict[str, Any]], None]


class FormatterEntry(TypedDict):
    phase: str
    fn: FormatterFn


class FieldMetadata(TypedDict, total=False):
    name: str
    type: FieldType
    visibility: Visibility
    readonly: bool
    required: bool
    nullable: bool
    validators: List[ValidatorFn]
    formatters: List[FormatterEntry]
    indexes: List[Dict[str, Any]]
    ephemeral: bool
    default: Dict[str, Any]


# `from` is a Python keyword, so EdgeMetadata uses the functional TypedDict form.
EdgeMetadata = TypedDict(
    "EdgeMetadata",
    {
        "from": str,
        "fromField": str,
        "to": str,
        "toField": str,
        "label": str,
        "directed": bool,
    },
)


class SchemaMetadata(TypedDict, total=False):
    name: str
    sourceName: str
    visibility: Visibility
    ephemeral: bool
    fields: List[FieldMetadata]
    indexes: List[Dict[str, Any]]
    refs: Dict[str, Any]
    edge: EdgeMetadata
    applyDefaults: SchemaDefaultsFn


# ── Service metadata (mirrors the static `service` on generated service classes) ──


class ServiceParamMetadata(TypedDict, total=False):
    name: str
    schema: str


class ServiceMethodMetadata(TypedDict, total=False):
    name: str
    visibility: Visibility
    params: List[ServiceParamMetadata]
    returnSchema: str
    returnArray: bool


class ServiceMetadata(TypedDict, total=False):
    name: str
    visibility: Visibility
    methods: List[ServiceMethodMetadata]
    refs: Dict[str, Any]


#: Ambient per-request context threaded through the server, plugins, and services.
RequestContext = Dict[str, Any]

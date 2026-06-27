"""Runtime metadata + RPC type aliases — the Python view of the data the compiler emits.

The class metadata is a plain ``dict`` with **camelCase** keys (the cross-language contract,
matching the IR and the JS runtime); only the Python *API* is snake_case. These ``TypedDict`` /
alias definitions exist for documentation and type-checking — the codec reads dicts directly, so
every key is optional in practice. Validator/formatter/edge/index/ephemeral metadata is owned by
the (separate, untouched) schema domain and is not modelled here.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, TypedDict

Visibility = Literal["public", "private"]

#: Wire encoding agreed statically by both ends of a transport (no negotiation).
Encoding = Literal["json", "binary"]

#: A field type node, e.g. ``{"kind": "string"}`` or ``{"kind": "array", "of": {...}}``.
#: See ``@keyma/core/ir`` for the authoritative union. Class targets are keyed by ``target``
#: (reference/embedded) or ``name`` (instance).
FieldType = Dict[str, Any]

#: A class-metadata dict (attached to a generated class as ``Class.metadata``).
Metadata = Dict[str, Any]


class FieldMetadata(TypedDict, total=False):
    name: str
    type: FieldType
    visibility: Visibility
    readonly: bool
    required: bool
    nullable: bool
    ephemeral: bool
    tag: int
    default: Dict[str, Any]


class ClassMetadata(TypedDict, total=False):
    name: str
    sourceName: str
    visibility: Visibility
    ephemeral: bool
    # OWN fields only (real inheritance). Inherited fields live on ``base``; the full set is
    # assembled by walking the base chain — see ``keyma.runtime.fields.all_fields``.
    fields: List[FieldMetadata]
    # Parent class's metadata when this class extends another (a live reference to
    # ``Parent.metadata``); absent for a root class.
    base: "ClassMetadata"
    # Embedded/reference target ``name`` → the target's generated class (carries ``.metadata``).
    refs: Dict[str, Any]


#: Ambient per-request context threaded through the host into service implementations. Open bag;
#: ``identity.isSystem`` drives the probe-resistant visibility gate.
RequestContext = Dict[str, Any]

import type { IRClassDeclaration, IRMember } from "@keyma/core/ir";
import { filterVisibleFields } from "@keyma/core/util";
import type {
    ClassMetadataOptions, MetadataClassDescriptor, MetadataFieldDescriptor,
    MetadataFieldIndex, MetadataIndex,
} from "@keyma/compiler";
import {
    schemaIndexes, schemaEdge, schemaEphemeral, fieldIndexes, fieldEphemeral, fieldForm,
    type IRIndex,
} from "./ir/extensions.js";

/**
 * Build the neutral, language-agnostic metadata descriptor for a class. This is the schema
 * domain's ONE class-metadata builder (registered into all three language packs): it reads the
 * core IR plus the schema/UI extensions (indexes / edge / ephemeral / visibility / form / tag)
 * and produces pure data. The per-language compiler backends render the descriptor into
 * `<Class>.metadata` (JS `Object.freeze({…})`, Python dict, C++ `keyma::ClassMetadata`), owning
 * all language syntax — including the live `base` (`Parent.metadata`) and `refs` references.
 *
 * The metadata is pure introspective data: behaviour (validate/format/defaults) lives in the
 * synthesized B methods, not here. The bundle gate maps to this domain's index rules — a `client`
 * bundle drops indexes; `server`/`library` keep everything.
 */
export function buildClassMetadata(cls: IRClassDeclaration, opts: ClassMetadataOptions): MetadataClassDescriptor {
    const includeIndexes = opts.bundle !== "client";
    const fields = filterVisibleFields(cls, opts.includePrivate).map((f) => buildFieldData(f, includeIndexes));
    const indexes = includeIndexes ? schemaIndexes(cls).map(buildIndexData) : [];

    const out: MetadataClassDescriptor = {
        name: cls.name,
        sourceName: cls.sourceName,
        fields,
    };
    if (indexes.length > 0) out.indexes = indexes;
    const edge = schemaEdge(cls);
    if (edge !== undefined) out.edge = edge;
    if (cls.visibility === "private") out.visibility = "private";
    if (schemaEphemeral(cls)) out.ephemeral = true;
    return out;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function buildFieldData(field: IRMember, includeIndexes: boolean): MetadataFieldDescriptor {
    const indexes: MetadataFieldIndex[] = includeIndexes ? fieldIndexes(field) : [];

    const out: MetadataFieldDescriptor = {
        name: field.name,
        type: field.type,
        required: field.required,
    };
    if (field.visibility === "private") out.visibility = "private";
    if (field.readonly) out.readonly = true;
    if (field.nullable) out.nullable = true;
    if (indexes.length > 0) out.indexes = indexes;
    if (fieldEphemeral(field)) out.ephemeral = true;
    // Only literal defaults ride in the metadata (applied generically by the runtime). Expression
    // defaults are re-emitted as runnable code at construction, so embedding their IR here would be
    // dead data — and would needlessly leak the expression into the client bundle.
    if (field.default !== undefined && field.default.kind === "literal") out.default = field.default;
    const form = fieldForm(field);
    if (form !== undefined) out.form = form;
    if (field.deprecated !== undefined) out.deprecated = field.deprecated;
    // Stable binary wire tag (present only when binary serialization is enabled).
    if (field.tag !== undefined) out.tag = field.tag;

    return out;
}

function buildIndexData(index: IRIndex): MetadataIndex {
    const out: MetadataIndex = { fields: index.fields };
    if (index.unique !== undefined) out.unique = index.unique;
    if (index.sparse !== undefined) out.sparse = index.sparse;
    if (index.name !== undefined) out.name = index.name;
    return out;
}

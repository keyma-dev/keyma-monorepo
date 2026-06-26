// Schema-domain IR extension payloads. These types and the per-node accessors are the
// schema domain's slice of the generic `extensions` channel on `IRSchema`/`IRField`
// (the `@keyma/core/ir` envelope reserves `extensions?: Record<string, unknown>` and
// neither sets nor reads it). The edge/index/ephemeral metadata used to live as
// first-class fields on the core IR; the carve relocated them here so `@keyma/core`'s
// IR is genuinely domain-neutral. The `IREdge`/`IRIndex`/`IRFieldIndex` type definitions
// moved here from `@keyma/core/ir` for the same reason.
import type { IRSchema, IRField } from "@keyma/core/ir";

/** Domain id keying the schema slice of the generic `extensions` channel. */
export const SCHEMA_EXT = "schema";

export type IRFieldIndex = {
    unique?: boolean;
    sparse?: boolean;
    direction?: 1 | -1 | "text";
    key?: string;
};

export type IRIndex = {
    fields: { name: string; direction: 1 | -1 | "text" }[];
    unique?: boolean;
    sparse?: boolean;
    name?: string;
};

/**
 * Metadata for a schema that represents an edge connecting two node schemas.
 * Present iff the user authored the class with `@Edge(...)`. The endpoints are
 * derived from the `@From()`/`@To()`-decorated fields: each field's name yields
 * `fromField`/`toField` and its declared node type yields `from`/`to`. Non-graph
 * backends ignore this; graph-aware backends use it to plan traversals.
 */
export type IREdge = {
    /** Source node schema's `name` — the `@From()` field's node type. */
    from: string;
    /** Name of the `@From()`-decorated field holding the source endpoint. */
    fromField: string;
    /** Target node schema's `name` — the `@To()` field's node type. */
    to: string;
    /** Name of the `@To()`-decorated field holding the target endpoint. */
    toField: string;
    /** Traversal label — the edge schema's `name`. */
    label: string;
    /** When false, the edge is undirected — adapters may treat both ends as equivalent. */
    directed: boolean;
};

/** The schema domain's per-schema extension slice (`schema.extensions['schema']`). */
export type SchemaExtData = {
    /** Present iff the class was decorated with `@Edge(...)`. */
    edge?: IREdge;
    /** Composite (schema-level) indexes. Absent ⇒ none. */
    indexes?: IRIndex[];
    /** When true, this schema is never persisted to the database. */
    ephemeral?: boolean;
};

/** The schema domain's per-field extension slice (`field.extensions['schema']`). */
export type FieldExtData = {
    /** Per-field indexes (single-field `@Indexed`). Absent ⇒ none. */
    indexes?: IRFieldIndex[];
    /** When true, the field is dropped before persistence. */
    ephemeral?: boolean;
};

// ─── Readers ──────────────────────────────────────────────────────────────────
// Live (mutable) reads of each node's schema-domain slice; `undefined` when the
// node carries no schema extension.

export function schemaExt(schema: IRSchema): SchemaExtData | undefined {
    return schema.extensions?.[SCHEMA_EXT] as SchemaExtData | undefined;
}

export function fieldExt(field: IRField): FieldExtData | undefined {
    return field.extensions?.[SCHEMA_EXT] as FieldExtData | undefined;
}

/** Composite indexes, defaulting to `[]` (these arrays were always-present pre-carve). */
export function schemaIndexes(schema: IRSchema): IRIndex[] {
    return schemaExt(schema)?.indexes ?? [];
}

/** Per-field indexes, defaulting to `[]` (always-present pre-carve). */
export function fieldIndexes(field: IRField): IRFieldIndex[] {
    return fieldExt(field)?.indexes ?? [];
}

export function schemaEdge(schema: IRSchema): IREdge | undefined {
    return schemaExt(schema)?.edge;
}

export function schemaEphemeral(schema: IRSchema): boolean {
    return schemaExt(schema)?.ephemeral === true;
}

export function fieldEphemeral(field: IRField): boolean {
    return fieldExt(field)?.ephemeral === true;
}

// ─── Writers (frontend only) ────────────────────────────────────────────────────

/** Get-or-create the mutable schema-domain slice on a schema. */
export function mutSchemaExt(schema: IRSchema): SchemaExtData {
    const exts = schema.extensions ?? (schema.extensions = {});
    let slice = exts[SCHEMA_EXT] as SchemaExtData | undefined;
    if (slice === undefined) {
        slice = {};
        exts[SCHEMA_EXT] = slice;
    }
    return slice;
}

/** Get-or-create the mutable schema-domain slice on a field. */
export function mutFieldExt(field: IRField): FieldExtData {
    const exts = field.extensions ?? (field.extensions = {});
    let slice = exts[SCHEMA_EXT] as FieldExtData | undefined;
    if (slice === undefined) {
        slice = {};
        exts[SCHEMA_EXT] = slice;
    }
    return slice;
}

/** True when a schema slice carries nothing (so it should not be attached). */
function schemaSliceEmpty(slice: SchemaExtData): boolean {
    return slice.edge === undefined && slice.indexes === undefined && slice.ephemeral === undefined;
}

/** True when a field slice carries nothing. */
function fieldSliceEmpty(slice: FieldExtData): boolean {
    return slice.indexes === undefined && slice.ephemeral === undefined;
}

/**
 * Replace (or remove, when empty) the schema-domain slice on a schema. Always writes a
 * fresh top-level `extensions` object so callers that shallow-spread a schema (e.g.
 * inheritance flattening) do not mutate the source node's extension by reference.
 */
export function setSchemaExtSlice(schema: IRSchema, slice: SchemaExtData): void {
    if (schemaSliceEmpty(slice)) {
        if (schema.extensions !== undefined) {
            const { [SCHEMA_EXT]: _drop, ...rest } = schema.extensions;
            if (Object.keys(rest).length > 0) schema.extensions = rest;
            else delete schema.extensions;
        }
        return;
    }
    schema.extensions = { ...(schema.extensions ?? {}), [SCHEMA_EXT]: slice };
}

/** Replace (or remove, when empty) the schema-domain slice on a field. */
export function setFieldExtSlice(field: IRField, slice: FieldExtData): void {
    if (fieldSliceEmpty(slice)) {
        if (field.extensions !== undefined) {
            const { [SCHEMA_EXT]: _drop, ...rest } = field.extensions;
            if (Object.keys(rest).length > 0) field.extensions = rest;
            else delete field.extensions;
        }
        return;
    }
    field.extensions = { ...(field.extensions ?? {}), [SCHEMA_EXT]: slice };
}

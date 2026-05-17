import type { SchemaMetadata } from "./types.js";
import type { TraversalSpec } from "./protocol.js";

// Recursive field selection spec: 1 = include scalar/reference-as-id/embedded-as-whole,
// object = embedded sub-field selection.
export type AdapterFieldSpec = 1 | { [field: string]: AdapterFieldSpec };

export type PopulateNode = {
    schema: SchemaMetadata;
    projection?: AdapterProjection;
};

export type PopulateSpec = { [field: string]: PopulateNode };

export type AdapterProjection = {
    fields?: { [key: string]: AdapterFieldSpec };
    populate?: PopulateSpec;
};

export type ListQuery = {
    where: Record<string, unknown>;
    sort: Record<string, 1 | -1>;
    skip?: number;
    limit?: number;
    projection?: AdapterProjection;
};

/** Capability flags advertised by a database adapter. Absent fields default
 *  to "not supported"; KeymaServer checks these before dispatching. */
export type AdapterCapabilities = {
    traverse?: boolean | {
        /** Maximum supported traversal depth. */
        maxDepth?: number;
        /** Whether the adapter can emit full paths (nodes + edges per row). */
        emitPaths?: boolean;
        /** Whether the adapter supports heterogeneous step chains (different
         *  edge types per hop). MongoDB/Postgres: yes; pure document stores: no. */
        heterogeneous?: boolean;
    };
};

/** Result rows returned from an adapter's traverse() call.
 *
 *  - "nodes" → records of the terminal node schema
 *  - "edges" → records of the last-hop edge schema
 *  - "paths" → array of `{ nodes, edges }` objects, one per matched path
 */
export type AdapterTraversalResult =
    | Record<string, unknown>[]
    | { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }[];

/** Resolved-schema context handed to an adapter's traverse() — saves the adapter
 *  from doing string-name lookups itself. */
export type AdapterTraversalContext = {
    /** Terminal-node schema (matches the operation's `schema`). */
    terminalSchema: SchemaMetadata;
    /** Starting-node schema (matches `spec.start.schema`). */
    startSchema: SchemaMetadata;
    /** All edge schemas referenced by the spec, keyed by schema name. */
    edges: ReadonlyMap<string, SchemaMetadata>;
    /** All node schemas needed for intermediate hops, keyed by schema name. */
    nodes: ReadonlyMap<string, SchemaMetadata>;
};

export interface KeymaDatabaseAdapter {
    ensureSchema(schema: SchemaMetadata): Promise<void>;
    create(
        schema: SchemaMetadata,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>>;
    read(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown> | null>;
    list(
        schema: SchemaMetadata,
        query: ListQuery,
    ): Promise<Record<string, unknown>[]>;
    update(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>>;
    delete(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
    ): Promise<void>;
    /** Optional capability surface. Adapters opt in by setting flags here. */
    readonly capabilities?: AdapterCapabilities;
    /** Optional graph traversal. Implementations are responsible for honoring
     *  the spec's `start`, `steps`/`repeat`+`depth`, `where`, and `emit`. */
    traverse?(
        ctx: AdapterTraversalContext,
        spec: TraversalSpec,
        projection?: AdapterProjection,
    ): Promise<AdapterTraversalResult>;
}

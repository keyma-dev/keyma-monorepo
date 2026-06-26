import type { SchemaMetadata, RequestContext } from "./types.js";
import type { AdapterProjection, KeymaDatabaseAdapter } from "./adapter.js";
import type { KeymaOperation, KeymaLeafResult } from "./protocol.js";

// `RequestContext` lives in types.ts (it's part of the inlined, dependency-free
// type surface); re-exported here so existing `./plugin.js` imports keep working.
export type { RequestContext };

export type KeymaReadAction = "read" | "list" | "traverse" | "count";
export type KeymaWriteAction = "create" | "update" | "delete";
export type KeymaAction = KeymaReadAction | KeymaWriteAction;

export interface KeymaServerPlugin {
    readonly name: string;

    /** Called once after the server is constructed. */
    init?(server: PluginServerHandle): Promise<void> | void;

    /** Rewrite the entire operation. This is called before any other hooks
     *  and allows plugins to inject filters into complex operations like
     *  traversals or nested populates. */
    transformOperation?(
        ctx: RequestContext,
        op: KeymaOperation,
    ):
        | Promise<KeymaOperation | undefined>
        | KeymaOperation
        | undefined;

    /** Observe or early-reject the operation. Throw a KeymaPluginError to abort. */
    beforeOperation?(
        ctx: RequestContext,
        op: KeymaOperation,
    ): Promise<void> | void;

    /** Rewrite the where clause for list/read/update/delete. Return undefined
     *  to leave unchanged. The returned filter may use top-level logical
     *  operators `$and` / `$or` / `$nor` (each carrying an array of sub-filter
     *  objects) to combine clauses; adapters translate these recursively. */
    transformFilter?(
        ctx: RequestContext,
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        action: KeymaAction,
    ):
        | Promise<Record<string, unknown> | undefined>
        | Record<string, unknown>
        | undefined;

    /** Trim the projection. Return undefined to leave unchanged. */
    transformProjection?(
        ctx: RequestContext,
        schema: SchemaMetadata,
        projection: AdapterProjection,
        action: KeymaAction,
    ): Promise<AdapterProjection | undefined> | AdapterProjection | undefined;

    /** Validate/strip a payload for create/update/delete. Throw a KeymaPluginError
     *  for hard reject. Return data (possibly mutated) or void. */
    checkWrite?(
        ctx: RequestContext,
        schema: SchemaMetadata,
        data: Record<string, unknown>,
        action: KeymaWriteAction,
    ):
        | Promise<Record<string, unknown> | void>
        | Record<string, unknown>
        | void;

    /** Post-process records leaving the server. */
    transformResult?(
        ctx: RequestContext,
        schema: SchemaMetadata,
        records: Record<string, unknown>[],
        action: KeymaAction,
    ):
        | Promise<Record<string, unknown>[] | undefined>
        | Record<string, unknown>[]
        | undefined;

    /** Called after every operation regardless of outcome. Throws here are
     *  swallowed (logged) so they cannot poison the response. */
    afterOperation?(
        ctx: RequestContext,
        op: KeymaOperation,
        result: KeymaLeafResult,
    ): Promise<void> | void;
}

/** Subset of KeymaServer that plugins are allowed to call during init.
 *  Avoids importing the concrete class (which would be a cycle). */
export interface PluginServerHandle {
    readonly schemas: readonly SchemaMetadata[];
    readonly adapter: KeymaDatabaseAdapter;
    schema(name: string): SchemaMetadata | undefined;
    addSchema(schema: SchemaMetadata): Promise<void> | void;
}

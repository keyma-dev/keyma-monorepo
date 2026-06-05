import type { SchemaMetadata } from "@keyma/runtime-js";
import type { GraphTraversalSource } from "./gremlin.js";

/** Index creation in Gremlin has no portable, vendor-neutral API: TinkerGraph
 *  indexes are configured on the graph instance, Neptune manages indexing
 *  automatically, and JanusGraph uses its own schema-management transaction.
 *  Because the adapter targets all of them through bytecode GLV, `ensureSchema`
 *  performs no index DDL — production indexes are configured on the server.
 *
 *  This hook is kept (and called from `ensureSchema`) so a future backend-aware
 *  subclass can specialize it without changing the adapter surface. */
export async function ensureIndexes(
    _g: GraphTraversalSource,
    _schema: SchemaMetadata,
): Promise<void> {
    // Intentionally a no-op — see the doc comment above.
}

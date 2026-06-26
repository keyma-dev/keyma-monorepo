import type {
    AdapterProjection,
    AdapterTraversalContext,
    AdapterTraversalResult,
    TraversalSpec,
} from "@keyma/runtime/schema";
import type { AnyDb, SchemaMap } from "./kysely.js";
import type { TableNameFn } from "./adapter.js";
import { runStepsTraversal } from "./traverse-steps.js";
import { runRepeatTraversal } from "./traverse-repeat.js";
import { SqliteAdapterInvalidQuery } from "./errors.js";

export async function runTraverse(
    db: AnyDb,
    ctx: AdapterTraversalContext,
    spec: TraversalSpec,
    projection: AdapterProjection | undefined,
    schemas: SchemaMap,
    tableName: TableNameFn,
): Promise<AdapterTraversalResult> {
    if (spec.steps !== undefined) {
        return runStepsTraversal(db, ctx, spec, projection, schemas, tableName);
    }
    if (spec.repeat !== undefined) {
        return runRepeatTraversal(db, ctx, spec, projection, schemas, tableName);
    }
    throw new SqliteAdapterInvalidQuery("traverse: spec must include either `steps` or `repeat`");
}

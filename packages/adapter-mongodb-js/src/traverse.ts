import type { Db } from "mongodb";
import type {
    AdapterProjection,
    AdapterTraversalContext,
    AdapterTraversalResult,
    SchemaMetadata,
    TraversalSpec,
} from "@keyma/runtime-js";
import { toRecord, type SchemaMap } from "./record.js";
import { type CollectionNameFn } from "./projection.js";
import { buildStepsPipeline } from "./traverse-steps.js";
import { buildPathsFallback, buildRepeatPipeline } from "./traverse-repeat.js";

export async function runTraverse(
    db: Db,
    ctx: AdapterTraversalContext,
    spec: TraversalSpec,
    projection: AdapterProjection | undefined,
    schemas: SchemaMap,
    collectionName: CollectionNameFn,
): Promise<AdapterTraversalResult> {
    const startColl = db.collection(collectionName(ctx.startSchema));

    if (spec.steps !== undefined) {
        const { stages, resultSchema } = buildStepsPipeline(
            spec,
            ctx,
            projection,
            schemas,
            collectionName,
        );
        const rows = await startColl.aggregate(stages).toArray();
        return shapeResults(rows, spec, ctx, resultSchema, schemas);
    }

    if (spec.repeat === undefined) {
        throw new Error("TraversalSpec requires either steps or repeat");
    }

    if (spec.emit === "paths") {
        // Unrolled fallback: run one pipeline per depth and merge.
        const min = spec.depth?.min ?? 1;
        const max = spec.depth?.max ?? 1;
        const rows: Record<string, unknown>[] = [];
        for (let d = min; d <= max; d++) {
            const { stages } = buildPathsFallback(
                spec,
                ctx,
                schemas,
                collectionName,
                d,
            );
            const batch = await startColl.aggregate(stages).toArray();
            for (const r of batch) rows.push(r as Record<string, unknown>);
        }
        return shapeResults(rows, spec, ctx, ctx.terminalSchema, schemas);
    }

    const { stages, resultSchema } = buildRepeatPipeline(
        spec,
        ctx,
        projection,
        schemas,
        collectionName,
    );
    const rows = await startColl.aggregate(stages).toArray();
    return shapeResults(rows, spec, ctx, resultSchema, schemas);
}

function shapeResults(
    rows: Record<string, unknown>[],
    spec: TraversalSpec,
    ctx: AdapterTraversalContext,
    resultSchema: SchemaMetadata,
    schemas: SchemaMap,
): AdapterTraversalResult {
    if (spec.emit === "paths") {
        return rows.map((row) => {
            const nodes = (row["nodes"] as Record<string, unknown>[]) ?? [];
            const edges = (row["edges"] as Record<string, unknown>[]) ?? [];
            return {
                nodes: nodes.map((n) => mapNodeRecord(n, ctx, spec, schemas)),
                edges: edges.map((e) => mapEdgeRecord(e, ctx, spec, schemas)),
            };
        });
    }
    return rows.map((r) => toRecord(r, resultSchema, schemas));
}

function mapNodeRecord(
    doc: Record<string, unknown>,
    ctx: AdapterTraversalContext,
    spec: TraversalSpec,
    schemas: SchemaMap,
): Record<string, unknown> {
    // For paths from steps mode, nodes[0] is the start, then alternates per step.
    // Without per-row schema info, we use terminalSchema as a best-effort —
    // sufficient when start/terminal schemas match field names. For a fully
    // correct mapping per row position would require more bookkeeping.
    return toRecord(doc, ctx.terminalSchema, schemas);
}

function mapEdgeRecord(
    doc: Record<string, unknown>,
    ctx: AdapterTraversalContext,
    spec: TraversalSpec,
    schemas: SchemaMap,
): Record<string, unknown> {
    if (spec.steps !== undefined && spec.steps.length > 0) {
        // Last-hop edge schema is the conventional shape, but for paths we
        // can't know index-by-index without extra metadata; use the first
        // step's edge as a best-effort. Adequate when all steps share one
        // edge schema (the common case) and falls back gracefully otherwise.
        const firstEdge = ctx.edges.get(spec.steps[0]!.via);
        if (firstEdge !== undefined) return toRecord(doc, firstEdge, schemas);
    }
    if (spec.repeat !== undefined) {
        const edge = ctx.edges.get(spec.repeat.via);
        if (edge !== undefined) return toRecord(doc, edge, schemas);
    }
    return doc;
}

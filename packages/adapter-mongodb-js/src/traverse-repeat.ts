import type {
    AdapterProjection,
    AdapterTraversalContext,
    SchemaMetadata,
    TraversalSpec,
} from "@keyma/runtime-js";
import { translateWhere } from "./filter.js";
import {
    buildAggregationProjection,
    buildLookupStages,
    type CollectionNameFn,
} from "./projection.js";
import type { SchemaMap } from "./record.js";
import { buildStepsPipeline } from "./traverse-steps.js";
import { MongoAdapterInvalidQuery } from "./errors.js";
import { applyListOptions } from "./list-options.js";

function endpointSchema(
    ctx: AdapterTraversalContext,
    sourceName: string,
): SchemaMetadata | undefined {
    for (const node of ctx.nodes.values()) {
        if (node.sourceName === sourceName) return node;
    }
    return undefined;
}

function graphLookupStage(
    edgeColl: string,
    direction: "out" | "in",
    edge: { fromField: string; toField: string },
    depthMax: number,
    edgeWhere: Record<string, unknown> | undefined,
    edgeSchema: SchemaMetadata,
    schemas: SchemaMap,
    as: string,
): Record<string, unknown> {
    const connectFromField = direction === "out" ? edge.toField : edge.fromField;
    const connectToField = direction === "out" ? edge.fromField : edge.toField;
    const stage: Record<string, unknown> = {
        from: edgeColl,
        startWith: "$_id",
        connectFromField,
        connectToField,
        maxDepth: Math.max(0, depthMax - 1),
        depthField: "_depth",
        as,
    };
    if (edgeWhere !== undefined) {
        stage["restrictSearchWithMatch"] = translateWhere(edgeWhere, edgeSchema, schemas);
    }
    return { $graphLookup: stage };
}

export function buildRepeatPipeline(
    spec: TraversalSpec,
    ctx: AdapterTraversalContext,
    projection: AdapterProjection | undefined,
    schemas: SchemaMap,
    collectionName: CollectionNameFn,
): { stages: Record<string, unknown>[]; resultSchema: SchemaMetadata } {
    const repeat = spec.repeat;
    if (repeat === undefined) {
        throw new MongoAdapterInvalidQuery("repeat pipeline requires spec.repeat");
    }
    const edgeSchema = ctx.edges.get(repeat.via);
    if (edgeSchema === undefined || edgeSchema.edge === undefined) {
        throw new MongoAdapterInvalidQuery(`Edge schema "${repeat.via}" not registered`);
    }
    const meta = edgeSchema.edge;
    const depthMax = spec.depth?.max ?? 1;
    const depthMin = spec.depth?.min ?? 1;
    const edgeColl = collectionName(edgeSchema);

    // TODO: `repeat.nodeWhere` is intentionally not honored here — $graphLookup
    // has no built-in mechanism to filter intermediate nodes mid-traversal.
    // Step mode (buildStepsPipeline) supports nodeWhere; the typed surface in
    // query.ts does not expose nodeWhere on `repeat` so users can't reach this
    // path from the public API.

    const stages: Record<string, unknown>[] = [];
    stages.push({
        $match: translateWhere(spec.start.where, ctx.startSchema, schemas),
    });

    if (repeat.direction === "both") {
        stages.push(
            graphLookupStage(
                edgeColl,
                "out",
                meta,
                depthMax,
                repeat.edgeWhere,
                edgeSchema,
                schemas,
                "_out_edges",
            ),
        );
        stages.push(
            graphLookupStage(
                edgeColl,
                "in",
                meta,
                depthMax,
                repeat.edgeWhere,
                edgeSchema,
                schemas,
                "_in_edges",
            ),
        );
        stages.push({
            $addFields: {
                _edges: { $concatArrays: ["$_out_edges", "$_in_edges"] },
            },
        });
    } else {
        stages.push(
            graphLookupStage(
                edgeColl,
                repeat.direction,
                meta,
                depthMax,
                repeat.edgeWhere,
                edgeSchema,
                schemas,
                "_edges",
            ),
        );
    }

    // Filter by min depth (graphLookup depthField is 0-indexed).
    if (depthMin > 1) {
        stages.push({
            $addFields: {
                _edges: {
                    $filter: {
                        input: "$_edges",
                        as: "e",
                        cond: { $gte: ["$$e._depth", depthMin - 1] },
                    },
                },
            },
        });
    }

    stages.push({ $unwind: "$_edges" });

    const emit = spec.emit;
    if (emit === "edges") {
        stages.push({ $replaceRoot: { newRoot: "$_edges" } });
        applyListOptions(stages, spec.options);
        return { stages, resultSchema: edgeSchema };
    }

    // Look up the terminal node for each traversed edge.
    const terminalSourceName =
        repeat.direction === "in" ? meta.from : meta.to;
    const terminalSchema =
        endpointSchema(ctx, terminalSourceName) ?? ctx.terminalSchema;
    const terminalField =
        repeat.direction === "in" ? meta.fromField : meta.toField;

    if (emit === "nodes") {
        stages.push({
            $lookup: {
                from: collectionName(terminalSchema),
                localField: "_edges." + terminalField,
                foreignField: "_id",
                as: "_node",
            },
        });
        stages.push({ $unwind: "$_node" });
        stages.push({ $replaceRoot: { newRoot: "$_node" } });
        // Distinct by _id, in case multiple edges reach the same node.
        stages.push({
            $group: { _id: "$_id", _doc: { $first: "$$ROOT" } },
        });
        stages.push({ $replaceRoot: { newRoot: "$_doc" } });
        if (spec.where !== undefined) {
            stages.push({ $match: translateWhere(spec.where, terminalSchema, schemas) });
        }
        applyListOptions(stages, spec.options);
        if (projection?.populate !== undefined) {
            stages.push(
                ...buildLookupStages(
                    terminalSchema,
                    projection.populate,
                    schemas,
                    collectionName,
                ),
            );
        }
        const finalProj = buildAggregationProjection(projection?.fields, projection?.populate);
        if (finalProj !== undefined) {
            stages.push({ $project: finalProj });
        }
        return { stages, resultSchema: terminalSchema };
    }

    // emit === "paths" — fallback: unrolled chained $lookup, one length per
    // depth in [depthMin, depthMax]. Throws stages out; caller must run each
    // length as its own pipeline and concat results.
    throw new Error("PATHS_FALLBACK");
}

/** For emit:"paths" in repeat mode, the caller needs to run one pipeline per
 *  depth in [min, max]. This builds the steps-mode pipeline for a given depth. */
export function buildPathsFallback(
    spec: TraversalSpec,
    ctx: AdapterTraversalContext,
    schemas: SchemaMap,
    collectionName: CollectionNameFn,
    depth: number,
): { stages: Record<string, unknown>[]; resultSchema: SchemaMetadata } {
    const repeat = spec.repeat!;
    const stepsSpec: TraversalSpec = {
        start: spec.start,
        emit: "paths",
        steps: Array.from({ length: depth }, () => ({
            via: repeat.via,
            direction: repeat.direction,
            ...(repeat.edgeWhere !== undefined ? { edgeWhere: repeat.edgeWhere } : {}),
        })),
        ...(spec.where !== undefined ? { where: spec.where } : {}),
    };
    return buildStepsPipeline(stepsSpec, ctx, undefined, schemas, collectionName);
}

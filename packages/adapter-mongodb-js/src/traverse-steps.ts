import type {
    AdapterProjection,
    AdapterTraversalContext,
    SchemaMetadata,
    TraversalDirection,
    TraversalSpec,
    TraversalStep,
} from "@keyma/runtime-js";
import { translateWhere } from "./filter.js";
import {
    buildAggregationProjection,
    buildLookupStages,
    type CollectionNameFn,
} from "./projection.js";
import type { SchemaMap } from "./record.js";
import { MongoAdapterInvalidQuery } from "./errors.js";

type Resolved = {
    edge: SchemaMetadata;
    nextNode: SchemaMetadata;
    localIdPath: string;
    edgeMatchExpr: Record<string, unknown>;
    edgeNextFieldExpr: string | Record<string, unknown>;
};

function nodeBySourceName(
    ctx: AdapterTraversalContext,
    sourceName: string,
): SchemaMetadata | undefined {
    for (const node of ctx.nodes.values()) {
        if (node.sourceName === sourceName) return node;
    }
    return undefined;
}

function resolveStep(
    step: TraversalStep,
    ctx: AdapterTraversalContext,
    localIdPath: string,
): Resolved {
    const edge = ctx.edges.get(step.via);
    if (edge === undefined || edge.edge === undefined) {
        throw new MongoAdapterInvalidQuery(`Edge schema "${step.via}" not registered`);
    }
    const meta = edge.edge;
    const dir: TraversalDirection = step.direction;
    let nextSourceName: string;
    let edgeMatchExpr: Record<string, unknown>;
    let edgeNextFieldExpr: string | Record<string, unknown>;
    // Pipeline-form $lookup uses `let` to bind parent values as `$$<name>`. The
    // parent value is referenced as `$<path>` in the let binding; inside the
    // pipeline it is `$$localId`.
    if (dir === "out") {
        nextSourceName = meta.to;
        edgeMatchExpr = { $eq: ["$" + meta.fromField, "$$localId"] };
        edgeNextFieldExpr = "$" + meta.toField;
    } else if (dir === "in") {
        nextSourceName = meta.from;
        edgeMatchExpr = { $eq: ["$" + meta.toField, "$$localId"] };
        edgeNextFieldExpr = "$" + meta.fromField;
    } else {
        // "both" — assumes self-loop (from === to). Match either endpoint and
        // pick the opposite side as the next-hop id.
        nextSourceName = meta.to;
        edgeMatchExpr = {
            $or: [
                { $eq: ["$" + meta.fromField, "$$localId"] },
                { $eq: ["$" + meta.toField, "$$localId"] },
            ],
        };
        edgeNextFieldExpr = {
            $cond: [
                { $eq: ["$" + meta.fromField, "$$localId"] },
                "$" + meta.toField,
                "$" + meta.fromField,
            ],
        };
    }
    const nextNode = nodeBySourceName(ctx, nextSourceName);
    if (nextNode === undefined) {
        throw new MongoAdapterInvalidQuery(`Node schema "${nextSourceName}" not registered`);
    }
    return { edge, nextNode, localIdPath, edgeMatchExpr, edgeNextFieldExpr };
}

export function buildStepsPipeline(
    spec: TraversalSpec,
    ctx: AdapterTraversalContext,
    projection: AdapterProjection | undefined,
    schemas: SchemaMap,
    collectionName: CollectionNameFn,
): { stages: Record<string, unknown>[]; resultSchema: SchemaMetadata } {
    const steps = spec.steps ?? [];
    if (steps.length === 0) {
        throw new MongoAdapterInvalidQuery("steps pipeline requires at least one step");
    }
    const stages: Record<string, unknown>[] = [];
    stages.push({
        $match: translateWhere(spec.start.where, ctx.startSchema, schemas),
    });
    stages.push({ $addFields: { _start: "$$ROOT" } });

    let prevIdPath = "_start._id";
    const stepResolutions: Resolved[] = [];
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const r = resolveStep(step, ctx, prevIdPath);
        stepResolutions.push(r);
        const edgePipeline: Record<string, unknown>[] = [
            { $match: { $expr: r.edgeMatchExpr } },
        ];
        if (step.edgeWhere !== undefined) {
            edgePipeline.push({ $match: translateWhere(step.edgeWhere, r.edge, schemas) });
        }
        if (step.direction === "both") {
            edgePipeline.push({
                $addFields: { _next: r.edgeNextFieldExpr },
            });
        }
        stages.push({
            $lookup: {
                from: collectionName(r.edge),
                let: { localId: "$" + r.localIdPath },
                pipeline: edgePipeline,
                as: "_e" + i,
            },
        });
        stages.push({ $unwind: "$_e" + i });

        const nextLocalField =
            step.direction === "both"
                ? "_e" + i + "._next"
                : "_e" +
                  i +
                  "." +
                  (step.direction === "out"
                      ? r.edge.edge!.toField
                      : r.edge.edge!.fromField);
        stages.push({
            $lookup: {
                from: collectionName(r.nextNode),
                localField: nextLocalField,
                foreignField: "_id",
                as: "_n" + i,
            },
        });
        stages.push({ $unwind: "$_n" + i });
        prevIdPath = "_n" + i + "._id";
    }

    const lastIdx = steps.length - 1;
    const terminalSchema = stepResolutions[lastIdx]!.nextNode;
    const emit = spec.emit;

    if (emit === "paths") {
        const nodeRefs = ["$_start", ...stepResolutions.map((_, i) => "$_n" + i)];
        const edgeRefs = stepResolutions.map((_, i) => "$_e" + i);
        stages.push({
            $project: { _id: 0, nodes: nodeRefs, edges: edgeRefs },
        });
        return { stages, resultSchema: terminalSchema };
    }

    if (emit === "edges") {
        stages.push({ $replaceRoot: { newRoot: "$_e" + lastIdx } });
        return { stages, resultSchema: stepResolutions[lastIdx]!.edge };
    }

    // emit === "nodes"
    stages.push({ $replaceRoot: { newRoot: "$_n" + lastIdx } });
    if (spec.where !== undefined) {
        stages.push({ $match: translateWhere(spec.where, terminalSchema, schemas) });
    }
    if (projection?.populate !== undefined) {
        stages.push(
            ...buildLookupStages(terminalSchema, projection.populate, schemas, collectionName),
        );
    }
    const finalProj = buildAggregationProjection(projection?.fields, projection?.populate);
    if (finalProj !== undefined) {
        stages.push({ $project: finalProj });
    }
    return { stages, resultSchema: terminalSchema };
}

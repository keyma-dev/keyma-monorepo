import type {
    AdapterTraversalContext,
    SchemaMetadata,
    TraversalSpec,
    TraversalStep,
} from "@keyma/runtime-js";
import { __ } from "./gremlin.js";
import type { GraphTraversal, GraphTraversalSource } from "./gremlin.js";
import { applyWhere } from "./filter.js";
import { applyListOptions } from "./list-options.js";
import { elementMapToPlain, fromProps, type SchemaMap } from "./props.js";
import { GremlinAdapterInvalidQuery } from "./errors.js";

export type LabelFns = {
    vertexLabel: (schema: SchemaMetadata) => string;
    edgeLabel: (schema: SchemaMetadata) => string;
};

/** Per-path row for `emit: "paths"`. */
export type PathRow = {
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
};

type Resolved = { edge: SchemaMetadata; nextNode: SchemaMetadata };

function nodeBySourceName(ctx: AdapterTraversalContext, sourceName: string): SchemaMetadata | undefined {
    for (const node of ctx.nodes.values()) {
        if (node.sourceName === sourceName) return node;
    }
    return undefined;
}

function resolveStep(step: TraversalStep, ctx: AdapterTraversalContext): Resolved {
    const edge = ctx.edges.get(step.via);
    if (edge === undefined || edge.edge === undefined) {
        throw new GremlinAdapterInvalidQuery(`Edge schema "${step.via}" not registered`);
    }
    const meta = edge.edge;
    // "both" assumes a self-loop (from === to); the opposite endpoint is reached
    // via otherV() so an explicit next-schema name isn't needed.
    const nextSourceName = step.direction === "in" ? meta.from : meta.to;
    const nextNode = nodeBySourceName(ctx, nextSourceName);
    if (nextNode === undefined) {
        throw new GremlinAdapterInvalidQuery(`Node schema "${nextSourceName}" not registered`);
    }
    return { edge, nextNode };
}

type Chain = {
    trav: GraphTraversal;
    nodeSchemas: SchemaMetadata[];
    edgeSchemas: SchemaMetadata[];
    nodeLabels: string[];
    edgeLabels: string[];
    terminalSchema: SchemaMetadata;
};

function buildChain(
    g: GraphTraversalSource,
    spec: TraversalSpec,
    steps: TraversalStep[],
    ctx: AdapterTraversalContext,
    schemas: SchemaMap,
    labels: LabelFns,
): Chain {
    let trav: GraphTraversal = applyWhere(
        g.V().hasLabel(labels.vertexLabel(ctx.startSchema)),
        spec.start.where,
        ctx.startSchema,
        schemas,
    ).as("n_0");

    const nodeSchemas: SchemaMetadata[] = [ctx.startSchema];
    const edgeSchemas: SchemaMetadata[] = [];
    const nodeLabels: string[] = ["n_0"];
    const edgeLabels: string[] = [];

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const r = resolveStep(step, ctx);
        const eLabel = labels.edgeLabel(r.edge);

        if (step.direction === "out") trav = trav.outE(eLabel);
        else if (step.direction === "in") trav = trav.inE(eLabel);
        else trav = trav.bothE(eLabel);

        if (step.edgeWhere !== undefined) {
            trav = applyWhere(trav, step.edgeWhere, r.edge, schemas);
        }
        const eAs = "e_" + i;
        trav = trav.as(eAs);
        edgeLabels.push(eAs);
        edgeSchemas.push(r.edge);

        if (step.direction === "out") trav = trav.inV();
        else if (step.direction === "in") trav = trav.outV();
        else trav = trav.otherV();

        if (step.nodeWhere !== undefined) {
            trav = applyWhere(trav, step.nodeWhere, r.nextNode, schemas);
        }
        const nAs = "n_" + (i + 1);
        trav = trav.as(nAs);
        nodeLabels.push(nAs);
        nodeSchemas.push(r.nextNode);
    }

    return {
        trav,
        nodeSchemas,
        edgeSchemas,
        nodeLabels,
        edgeLabels,
        terminalSchema: nodeSchemas[nodeSchemas.length - 1]!,
    };
}

/** Execute one heterogeneous step chain and return records shaped per `emit`.
 *  Applies start/edge/node/terminal filters and (for node/edge emit, when
 *  `inQueryOptions` is set) pushes dedup/sort/skip/limit down into the Gremlin
 *  traversal. `inQueryOptions` must be false when the caller merges results
 *  across multiple chains (the `repeat` unroll) — there, ordering and
 *  pagination span all the sub-queries and are finalized in memory. Projection
 *  is never applied here. */
export async function runSteps(
    g: GraphTraversalSource,
    spec: TraversalSpec,
    steps: TraversalStep[],
    ctx: AdapterTraversalContext,
    schemas: SchemaMap,
    labels: LabelFns,
    inQueryOptions: boolean,
): Promise<Record<string, unknown>[] | PathRow[]> {
    if (steps.length === 0) {
        throw new GremlinAdapterInvalidQuery("traversal requires at least one step");
    }
    const chain = buildChain(g, spec, steps, ctx, schemas, labels);

    if (spec.emit === "edges") {
        const lastEdge = chain.edgeLabels[chain.edgeLabels.length - 1]!;
        let trav = chain.trav.select(lastEdge).dedup();
        if (inQueryOptions) trav = applyListOptions(trav, spec.options);
        const rows = (await trav.valueMap(true).toList()) as unknown[];
        const edgeSchema = chain.edgeSchemas[chain.edgeSchemas.length - 1]!;
        return rows.map((r) => fromProps(elementMapToPlain(r), edgeSchema, schemas));
    }

    if (spec.emit === "paths") {
        let trav = chain.trav;
        if (spec.where !== undefined) {
            trav = applyWhere(trav, spec.where, chain.terminalSchema, schemas);
        }
        const ordered = interleave(chain.nodeLabels, chain.edgeLabels);
        const rows = (await trav.select(...ordered).by(__.valueMap(true)).toList()) as unknown[];
        return rows.map((row) => {
            const m = elementMapToPlain(row);
            return {
                nodes: chain.nodeLabels.map((l, i) =>
                    fromProps(elementMapToPlain(m[l]), chain.nodeSchemas[i]!, schemas),
                ),
                edges: chain.edgeLabels.map((l, i) =>
                    fromProps(elementMapToPlain(m[l]), chain.edgeSchemas[i]!, schemas),
                ),
            };
        });
    }

    // emit === "nodes"
    let trav = chain.trav;
    if (spec.where !== undefined) {
        trav = applyWhere(trav, spec.where, chain.terminalSchema, schemas);
    }
    trav = trav.dedup();
    if (inQueryOptions) trav = applyListOptions(trav, spec.options);
    const rows = (await trav.valueMap(true).toList()) as unknown[];
    return rows.map((r) => fromProps(elementMapToPlain(r), chain.terminalSchema, schemas));
}

// Order labels as n_0, e_0, n_1, e_1, ..., n_k for a path select().
function interleave(nodes: string[], edges: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
        out.push(nodes[i]!);
        if (i < edges.length) out.push(edges[i]!);
    }
    return out;
}

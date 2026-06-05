import type {
    AdapterTraversalContext,
    AdapterTraversalResult,
    TraversalSpec,
    TraversalStep,
} from "@keyma/runtime-js";
import type { GraphTraversalSource } from "./gremlin.js";
import type { SchemaMap } from "./props.js";
import { runSteps, type LabelFns, type PathRow } from "./traverse-steps.js";
import { applyListOptionsInMemory } from "./list-options.js";
import { GremlinAdapterInvalidQuery } from "./errors.js";

/** Run a traversal spec end-to-end (minus node projection, which the adapter
 *  applies afterwards). Heterogeneous `steps` run as a single chain; a
 *  homogeneous `repeat` is expanded into one chain per depth in [min, max] and
 *  the results are merged — mirroring the MongoDB adapter's unrolled fallback,
 *  and giving uniform handling across nodes/edges/paths. */
export async function runTraverse(
    g: GraphTraversalSource,
    ctx: AdapterTraversalContext,
    spec: TraversalSpec,
    schemas: SchemaMap,
    labels: LabelFns,
): Promise<AdapterTraversalResult> {
    if (spec.steps !== undefined) {
        const rows = await runSteps(g, spec, spec.steps, ctx, schemas, labels);
        return finalize(rows, spec);
    }
    if (spec.repeat === undefined) {
        throw new GremlinAdapterInvalidQuery("TraversalSpec requires either steps or repeat");
    }

    const repeat: TraversalStep = spec.repeat;
    const min = spec.depth?.min ?? 1;
    const max = spec.depth?.max ?? 1;
    if (min > max) return finalize([], spec);

    const nodeRows: Record<string, unknown>[] = [];
    const pathRows: PathRow[] = [];
    for (let d = min; d <= max; d++) {
        const steps: TraversalStep[] = Array.from({ length: d }, () => ({ ...repeat }));
        const rows = await runSteps(g, spec, steps, ctx, schemas, labels);
        if (spec.emit === "paths") pathRows.push(...(rows as PathRow[]));
        else nodeRows.push(...(rows as Record<string, unknown>[]));
    }

    if (spec.emit === "paths") return finalize(pathRows, spec);
    return finalize(dedupById(nodeRows), spec);
}

function finalize(
    rows: Record<string, unknown>[] | PathRow[],
    spec: TraversalSpec,
): AdapterTraversalResult {
    if (spec.emit === "paths") {
        const paths = rows as PathRow[];
        return applyListOptionsInMemory(paths, spec.options, (p) =>
            p.nodes.length > 0 ? p.nodes[p.nodes.length - 1]! : {},
        );
    }
    const records = rows as Record<string, unknown>[];
    return applyListOptionsInMemory(records, spec.options, (r) => r);
}

function dedupById(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    const seen = new Set<unknown>();
    const out: Record<string, unknown>[] = [];
    for (const r of rows) {
        const id = r["id"];
        if (id !== undefined && seen.has(id)) continue;
        if (id !== undefined) seen.add(id);
        out.push(r);
    }
    return out;
}

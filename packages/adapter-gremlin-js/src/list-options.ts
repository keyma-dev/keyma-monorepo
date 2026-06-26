import type { ListOptions } from "@keyma/runtime/schema";
import type { GraphTraversal } from "./gremlin.js";
import { applyOrder, applyRange, translateSort, type SortEntry } from "./filter.js";

/** Push sort/skip/limit down into a single Gremlin traversal as
 *  `order().by(...).range(...)`. Adds the same trailing `id` tiebreaker as
 *  {@link applyListOptionsInMemory} so a sliced result is deterministic under
 *  ties, but lets the graph engine do the ordering and pagination.
 *
 *  Only valid when the whole result set is produced by one traversal — i.e. a
 *  single node/edge chain. The `repeat`-unrolled and `paths` shapes assemble
 *  their rows across multiple sub-queries (or post-hoc) and must finalize in
 *  memory instead. */
export function applyListOptions(
    trav: GraphTraversal,
    options: ListOptions | undefined,
): GraphTraversal {
    if (options === undefined) return trav;
    const { skip, limit, sort } = options;
    if (skip === undefined && limit === undefined && sort === undefined) return trav;

    const entries = translateSort(sort);
    const hasId = entries.some((e) => e.key === "id");
    const order: SortEntry[] = hasId ? entries : [...entries, { key: "id", desc: false }];

    return applyRange(applyOrder(trav, order), skip, limit);
}

/** Apply sort/skip/limit to an already-materialized result set in memory.
 *
 *  Traverse results (and their `paths` shape) are assembled across multiple
 *  sub-queries, so ordering/pagination is applied here rather than in a single
 *  Gremlin traversal. A trailing `id` tiebreaker is always added so skip/limit
 *  return a deterministic slice even when the sort key has ties — matching the
 *  MongoDB adapter's `applyListOptions` semantics.
 *
 *  `keyOf` extracts the comparable record from each row (identity for node/edge
 *  rows; the terminal node for `paths` rows). */
export function applyListOptionsInMemory<T>(
    rows: T[],
    options: ListOptions | undefined,
    keyOf: (row: T) => Record<string, unknown>,
): T[] {
    if (options === undefined) return rows;
    const { skip, limit, sort } = options;
    if (skip === undefined && limit === undefined && sort === undefined) return rows;

    const entries = translateSort(sort);
    const hasId = entries.some((e) => e.key === "id");
    const order: SortEntry[] = hasId ? entries : [...entries, { key: "id", desc: false }];

    const sorted = [...rows].sort((a, b) => compareBy(keyOf(a), keyOf(b), order));
    const from = skip ?? 0;
    const to = limit === undefined ? sorted.length : from + limit;
    return sorted.slice(from, to);
}

function compareBy(
    a: Record<string, unknown>,
    b: Record<string, unknown>,
    order: SortEntry[],
): number {
    for (const e of order) {
        const c = compareValues(a[e.key], b[e.key]);
        if (c !== 0) return e.desc ? -c : c;
    }
    return 0;
}

function compareValues(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a === undefined || a === null) return -1;
    if (b === undefined || b === null) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

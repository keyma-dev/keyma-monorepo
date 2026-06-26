import type { SchemaMetadata, ListQuery } from "@keyma/runtime/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQB = any;

/** Apply ORDER BY / LIMIT / OFFSET to a select query builder, with a stable
 *  `id` tiebreaker so paginated lists are deterministic. */
export function applyListOptions<QB extends AnyQB>(
    qb: QB,
    schema: SchemaMetadata,
    query: Pick<ListQuery, "sort" | "skip" | "limit">,
): QB {
    const sort = query.sort ?? {};
    const sortKeys = Object.keys(sort);
    let out: AnyQB = qb;
    let hasIdSort = false;
    for (const key of sortKeys) {
        const dir = sort[key];
        if (dir === undefined) continue;
        if (key === "id") hasIdSort = true;
        out = out.orderBy(key, dir === -1 ? "desc" : "asc");
    }
    if (!hasIdSort) {
        // Deterministic tiebreaker.
        out = out.orderBy(`${schema.name}.id`, "asc");
    }
    if (query.skip !== undefined) out = out.offset(query.skip);
    if (query.limit !== undefined) out = out.limit(query.limit);
    return out as QB;
}

import type { ListOptions } from "@keyma/runtime/schema";
import { translateSort } from "./filter.js";

/** Append $sort / $skip / $limit stages to `stages` based on `options`.
 *
 *  - Always appends `_id` ascending as a tiebreaker so that skip/limit return a
 *    deterministic slice even when the user's sort key has ties. The tiebreaker
 *    is omitted if the user already supplied a direction for `_id` / `id`.
 *  - If `options` only contains `skip` and/or `limit` (no sort), defaults to
 *    sorting by `_id` ascending so the slice is still stable.
 *  - `sortPrefix`, when set, is prepended to every sort key (including the
 *    tiebreaker). Used by traverse `emit: "paths"` to sort by a nested
 *    terminal-node path like `nodes.2.name`.
 */
export function applyListOptions(
    stages: Record<string, unknown>[],
    options: ListOptions | undefined,
    opts: { sortPrefix?: string } = {},
): void {
    if (options === undefined) return;
    const { skip, limit, sort } = options;
    if (skip === undefined && limit === undefined && sort === undefined) return;

    const translated = sort !== undefined ? translateSort(sort) : {};
    const hasIdSort = "_id" in translated;
    const prefix = opts.sortPrefix ?? "";
    const sortSpec: Record<string, 1 | -1> = {};
    for (const [k, dir] of Object.entries(translated)) {
        sortSpec[prefix + k] = dir;
    }
    if (!hasIdSort) {
        sortSpec[prefix + "_id"] = 1;
    }
    stages.push({ $sort: sortSpec });
    if (skip !== undefined) stages.push({ $skip: skip });
    if (limit !== undefined) stages.push({ $limit: limit });
}

import type { AdapterProjection, SchemaMetadata } from "@keyma/runtime-js";
import type { AclRule } from "./types.js";

/** Compute the set of allowed read fields for a (schema, rules) pair.
 *
 *  - If any matching allow rule has no `fields.read` → no field restriction
 *    (return undefined, callers leave the projection alone).
 *  - Otherwise → union of all `fields.read` arrays. */
export function allowedReadFields(
    rules: ReadonlyArray<AclRule>,
): Set<string> | undefined {
    const allows = rules.filter((r) => (r.effect ?? "allow") === "allow");
    if (allows.length === 0) return new Set();
    if (allows.some((r) => r.fields?.read === undefined)) return undefined;
    const out = new Set<string>();
    for (const r of allows) {
        for (const f of r.fields!.read!) out.add(f);
    }
    return out;
}

/** Same logic for write fields. */
export function allowedWriteFields(
    rules: ReadonlyArray<AclRule>,
): Set<string> | undefined {
    const allows = rules.filter((r) => (r.effect ?? "allow") === "allow");
    if (allows.length === 0) return new Set();
    if (allows.some((r) => r.fields?.write === undefined)) return undefined;
    const out = new Set<string>();
    for (const r of allows) {
        for (const f of r.fields!.write!) out.add(f);
    }
    return out;
}

/** Trim an AdapterProjection to only top-level allowed fields. `id` is always
 *  retained so the adapter can return identifiable records. */
export function trimProjection(
    projection: AdapterProjection,
    allowed: ReadonlySet<string>,
): AdapterProjection {
    const out: AdapterProjection = {};
    if (projection.fields !== undefined) {
        const next: typeof projection.fields = {};
        for (const [k, v] of Object.entries(projection.fields)) {
            if (k === "id" || allowed.has(k)) next[k] = v;
        }
        if (Object.keys(next).length > 0) out.fields = next;
    }
    if (projection.populate !== undefined) {
        const next: typeof projection.populate = {};
        for (const [k, v] of Object.entries(projection.populate)) {
            if (allowed.has(k)) next[k] = v;
        }
        if (Object.keys(next).length > 0) out.populate = next;
    }
    return out;
}

/** Augment a projection with extra top-level fields the plugin needs to
 *  evaluate predicates (e.g. {author: "$self"} requires `author` in the
 *  fetched record). Returns the new projection and the keys that were added
 *  (so they can be stripped from results before returning to the caller). */
export function augmentProjectionForPredicate(
    projection: AdapterProjection,
    extra: ReadonlySet<string>,
    schema: SchemaMetadata,
): { projection: AdapterProjection; added: Set<string> } {
    if (extra.size === 0) return { projection, added: new Set() };
    const fields = { ...(projection.fields ?? {}) };
    const added = new Set<string>();
    const validFieldNames = new Set(schema.fields.map((f) => f.name));
    for (const f of extra) {
        if (!validFieldNames.has(f)) continue;
        if (!(f in fields)) {
            fields[f] = 1;
            added.add(f);
        }
    }
    const out: AdapterProjection = { ...projection, fields };
    return { projection: out, added };
}

/** Collect top-level field names referenced by a filter (for both predicate
 *  pull-in and write-side checks). */
export function fieldsReferenced(filter: Record<string, unknown> | undefined): Set<string> {
    const out = new Set<string>();
    if (filter === undefined) return out;
    walk(filter, out);
    return out;
}

function walk(value: unknown, out: Set<string>): void {
    if (Array.isArray(value)) {
        for (const v of value) walk(v, out);
        return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k.startsWith("$")) {
            walk(v, out);
        } else {
            out.add(k);
            // Don't descend; nested keys at this level are operator keys.
        }
    }
}

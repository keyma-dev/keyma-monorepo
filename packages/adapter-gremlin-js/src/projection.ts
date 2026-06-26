import type { AdapterFieldSpec, AdapterProjection } from "@keyma/runtime/schema";

/** Prune a fully-materialized record down to a projection's `fields` selection,
 *  preserving any keys produced by `populate` (resolved references). When
 *  `fields` is absent every key is kept. Embedded sub-selection recurses. */
export function selectFields(
    record: Record<string, unknown>,
    projection: AdapterProjection | undefined,
): Record<string, unknown> {
    const fields = projection?.fields;
    if (fields === undefined) return record;
    const out = pickFields(record, fields);
    if (projection?.populate !== undefined) {
        for (const k of Object.keys(projection.populate)) {
            if (k in record) out[k] = record[k];
        }
    }
    return out;
}

function pickFields(
    record: Record<string, unknown>,
    fields: { [key: string]: AdapterFieldSpec },
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(fields)) {
        if (!(key in record)) continue;
        const value = record[key];
        if (spec === 1) {
            out[key] = value;
        } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            out[key] = pickFields(value as Record<string, unknown>, spec);
        } else {
            out[key] = value;
        }
    }
    return out;
}

/** True when the projection asks for populated references. */
export function hasPopulate(projection: AdapterProjection | undefined): boolean {
    return projection?.populate !== undefined && Object.keys(projection.populate).length > 0;
}

import type { FieldType, SchemaMetadata } from "@keyma/runtime-js";

export type SchemaMap = ReadonlyMap<string, SchemaMetadata>;

/** A single Gremlin property to write onto a vertex/edge.
 *  - `list: true` → write with list cardinality (one `property(list, key, v)`
 *    call per element). Only valid on vertices; edges fall back to a single
 *    JSON-encoded value. */
export type PropEntry = { key: string; value: unknown; list?: boolean };

/** Flat property representation of a record, ready to apply to a traversal.
 *  `id` is split out (it maps to the element's `T.id`, never a property) and
 *  `nulls` lists the property keys to drop (fields explicitly set to `null`,
 *  used by `update` to clear values — Gremlin has no null property value). */
export type Props = {
    id: unknown | undefined;
    props: PropEntry[];
    nulls: string[];
};

// ── Scalar coercion ─────────────────────────────────────────────────────────
// Gremlin property values must be primitives for portability across TinkerGraph
// / Neptune / JanusGraph. bigint and decimal are stored as strings (lossless,
// equality-comparable; range queries are not supported on them — documented).
// Dates use ISO-8601 strings (lexically sortable). Bytes use base64.

function toGremlin(value: unknown, type: FieldType): unknown {
    if (value === null || value === undefined) return value;
    const t = type;
    switch (t.kind) {
        case "bigint":
            return typeof value === "bigint" ? value.toString() : String(value);
        case "decimal":
            return String(value);
        case "bytes":
            if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
            return value;
        case "dateTime":
        case "date":
        case "time":
            return value instanceof Date ? value.toISOString() : value;
        case "json":
            return JSON.stringify(value);
        default:
            // string / number / integer / boolean / enum / id / reference
            return value;
    }
}

function fromGremlin(value: unknown, type: FieldType): unknown {
    if (value === null || value === undefined) return value;
    const t = type;
    switch (t.kind) {
        case "bigint":
            return BigInt(value as string | number);
        case "decimal":
            return String(value);
        case "bytes":
            if (typeof value === "string") return new Uint8Array(Buffer.from(value, "base64"));
            return value;
        case "dateTime":
            return typeof value === "string" ? new Date(value) : value;
        case "json":
            return typeof value === "string" ? JSON.parse(value) : value;
        default:
            return value;
    }
}

/** Convert a Keyma record into a flat property list. Embedded sub-documents are
 *  flattened to dotted keys (`address.city`) so they remain queryable; arrays of
 *  primitives become multi-properties (list cardinality) unless `multiProperty`
 *  is false (edges), in which case they are JSON-encoded into a single value. */
export function toProps(
    data: Record<string, unknown>,
    schema: SchemaMetadata,
    schemas: SchemaMap,
    opts: { excludeId?: boolean; multiProperty?: boolean; excludeFields?: string[] } = {},
): Props {
    const multiProperty = opts.multiProperty ?? true;
    const excludeFields = new Set(opts.excludeFields ?? []);
    const props: PropEntry[] = [];
    const nulls: string[] = [];
    let id: unknown | undefined;

    for (const field of schema.fields) {
        if (!(field.name in data)) continue;
        const value = data[field.name];
        if (value === undefined) continue;
        if (field.name === "id") {
            if (opts.excludeId !== true) id = value;
            continue;
        }
        if (excludeFields.has(field.name)) continue;
        if (value === null) {
            nulls.push(field.name);
            continue;
        }
        emitField(field.name, value, field.type, schemas, multiProperty, props);
    }
    return { id, props, nulls };
}

function emitField(
    key: string,
    value: unknown,
    type: FieldType,
    schemas: SchemaMap,
    multiProperty: boolean,
    out: PropEntry[],
): void {
    const t = type;
    if (t.kind === "embedded") {
        const sub = schemas.get(t.schema);
        if (sub === undefined || typeof value !== "object" || value === null) {
            out.push({ key, value });
            return;
        }
        const obj = value as Record<string, unknown>;
        for (const f of sub.fields) {
            if (f.name === "id") continue;
            if (!(f.name in obj)) continue;
            const v = obj[f.name];
            if (v === undefined || v === null) continue;
            emitField(`${key}.${f.name}`, v, f.type, schemas, multiProperty, out);
        }
        return;
    }
    if (t.kind === "array") {
        if (!Array.isArray(value)) {
            out.push({ key, value });
            return;
        }
        const elems = value.map((v) => scalarOrJson(v, t.of, schemas));
        if (multiProperty) {
            out.push({ key, value: elems, list: true });
        } else {
            out.push({ key, value: JSON.stringify(elems) });
        }
        return;
    }
    out.push({ key, value: toGremlin(value, t) });
}

// Array elements that are themselves embedded/complex can't be flattened to
// dotted keys (a list has no single path), so they are JSON-encoded per element.
function scalarOrJson(value: unknown, type: FieldType, schemas: SchemaMap): unknown {
    const t = type;
    if (t.kind === "embedded" || t.kind === "array" || t.kind === "json") {
        return JSON.stringify(value);
    }
    return toGremlin(value, t);
}

/** Rebuild a Keyma record from an `elementMap`-shaped plain object. Re-nests
 *  dotted embedded keys, unwraps single-element multi-property arrays, coerces
 *  scalars back, and lifts the element's `id` (from `T.id`) to a string. */
export function fromProps(
    plain: Record<string, unknown>,
    schema: SchemaMetadata,
    schemas: SchemaMap,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of schema.fields) {
        if (field.name === "id") {
            if (plain["id"] !== undefined && plain["id"] !== null) {
                out["id"] = String(plain["id"]);
            }
            continue;
        }
        const t = field.type;
        if (t.kind === "embedded") {
            const sub = schemas.get(t.schema);
            const nested = sub === undefined ? undefined : readEmbedded(plain, field.name, sub, schemas);
            if (nested !== undefined) out[field.name] = nested;
            continue;
        }
        if (!(field.name in plain)) continue;
        const raw = plain[field.name];
        if (t.kind === "array") {
            const arr = Array.isArray(raw) ? raw : [raw];
            out[field.name] = arr.map((v) => readArrayElem(v, t.of));
            continue;
        }
        // elementMap returns multi-properties as arrays; unwrap a stray single.
        const scalar = Array.isArray(raw) ? raw[0] : raw;
        out[field.name] = fromGremlin(scalar, t);
    }
    return out;
}

function readEmbedded(
    plain: Record<string, unknown>,
    prefix: string,
    sub: SchemaMetadata,
    schemas: SchemaMap,
): Record<string, unknown> | undefined {
    const obj: Record<string, unknown> = {};
    let found = false;
    for (const f of sub.fields) {
        if (f.name === "id") continue;
        const t = f.type;
        const key = `${prefix}.${f.name}`;
        if (t.kind === "embedded") {
            const deeper = schemas.get(t.schema);
            const nested = deeper === undefined ? undefined : readEmbedded(plain, key, deeper, schemas);
            if (nested !== undefined) {
                obj[f.name] = nested;
                found = true;
            }
            continue;
        }
        if (!(key in plain)) continue;
        found = true;
        const raw = plain[key];
        if (t.kind === "array") {
            const arr = Array.isArray(raw) ? raw : [raw];
            obj[f.name] = arr.map((v) => readArrayElem(v, t.of));
        } else {
            const scalar = Array.isArray(raw) ? raw[0] : raw;
            obj[f.name] = fromGremlin(scalar, t);
        }
    }
    return found ? obj : undefined;
}

function readArrayElem(value: unknown, type: FieldType): unknown {
    const t = type;
    if (t.kind === "embedded" || t.kind === "array" || t.kind === "json") {
        return typeof value === "string" ? JSON.parse(value) : value;
    }
    return fromGremlin(value, t);
}

/** Convert a Keyma filter literal to its stored Gremlin form (mirrors the write
 *  coercion) so `where` comparisons match what `toProps` persisted. */
export function valueToGremlin(value: unknown, type: FieldType | undefined): unknown {
    if (type === undefined) return value;
    return toGremlin(value, type);
}

/** Normalize a `valueMap(true)` / `elementMap()` result (a JS `Map` whose
 *  `T.id`/`T.label` keys are EnumValue tokens) into a plain object keyed by
 *  strings. Reads use `valueMap(true)` so multi-properties survive as arrays. */
export function elementMapToPlain(m: unknown): Record<string, unknown> {
    if (m instanceof Map) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of m.entries()) out[normalizeKey(k)] = v;
        return out;
    }
    return (m ?? {}) as Record<string, unknown>;
}

function normalizeKey(k: unknown): string {
    if (typeof k === "string") return k;
    if (k !== null && typeof k === "object" && "elementName" in k) {
        return String((k as { elementName: unknown }).elementName);
    }
    return String(k);
}

export function findFieldType(schema: SchemaMetadata, name: string): FieldType | undefined {
    return schema.fields.find((f) => f.name === name)?.type;
}

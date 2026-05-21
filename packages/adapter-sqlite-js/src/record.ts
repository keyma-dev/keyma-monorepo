import type { FieldType, SchemaMetadata } from "@keyma/runtime-js";
import type { SchemaMap } from "./kysely.js";

/** Convert a Keyma value to its SQLite-bindable form for the given IR type.
 *  `null`/`undefined` pass through. Composite kinds (embedded/array/json) are
 *  serialized to JSON strings; SQLite stores them as TEXT. */
export function toSqlite(
    value: unknown,
    type: FieldType,
    schemas: SchemaMap,
): unknown {
    if (value === null || value === undefined) return value;
    switch (type.kind) {
        case "nullable":
            return toSqlite(value, type.of, schemas);
        case "boolean":
            return value ? 1 : 0;
        case "bigint":
            return typeof value === "bigint" ? value.toString() : String(value);
        case "decimal":
            return String(value);
        case "date":
        case "dateTime":
        case "time":
            if (value instanceof Date) return value.toISOString();
            return value;
        case "bytes":
            if (value instanceof Uint8Array) return Buffer.from(value);
            return value;
        case "json":
            return JSON.stringify(value);
        case "embedded": {
            const sub = schemas.get(type.schema);
            if (sub === undefined) return JSON.stringify(value);
            return JSON.stringify(encodeRecord(value as Record<string, unknown>, sub, schemas));
        }
        case "array": {
            if (!Array.isArray(value)) return value;
            return JSON.stringify(value.map((v) => prepareJsonElement(v, type.of, schemas)));
        }
        default:
            return value;
    }
}

/** Convert a value coming back from SQLite into its Keyma-shaped form. */
export function fromSqlite(
    value: unknown,
    type: FieldType,
    schemas: SchemaMap,
): unknown {
    if (value === null || value === undefined) return value;
    switch (type.kind) {
        case "nullable":
            return fromSqlite(value, type.of, schemas);
        case "boolean":
            return value === 1 || value === true || value === "1";
        case "bigint":
            return typeof value === "string" ? BigInt(value) : value;
        case "decimal":
            return typeof value === "string" ? value : String(value);
        case "date":
        case "dateTime":
        case "time":
            return typeof value === "string" ? new Date(value) : value;
        case "bytes":
            if (Buffer.isBuffer(value)) {
                return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            }
            if (value instanceof Uint8Array) return value;
            return value;
        case "json":
            return typeof value === "string" ? JSON.parse(value) : value;
        case "embedded": {
            if (typeof value !== "string") return value;
            const parsed = JSON.parse(value) as Record<string, unknown>;
            const sub = schemas.get(type.schema);
            if (sub === undefined) return parsed;
            return decodeRecord(parsed, sub, schemas);
        }
        case "array": {
            if (typeof value !== "string") return value;
            const parsed = JSON.parse(value) as unknown[];
            return parsed.map((v) => readJsonElement(v, type.of, schemas));
        }
        case "integer":
            return typeof value === "bigint" ? Number(value) : value;
        default:
            return value;
    }
}

/** Encode a JS object as a JSON-storable plain object using its schema. Used
 *  recursively from `embedded` and array-of-embedded. */
function encodeRecord(
    obj: Record<string, unknown>,
    schema: SchemaMetadata,
    schemas: SchemaMap,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of schema.fields) {
        if (!(field.name in obj)) continue;
        const v = obj[field.name];
        if (v === undefined) continue;
        out[field.name] = prepareJsonElement(v, field.type, schemas);
    }
    return out;
}

/** Decode a JSON-stored object back to its Keyma record shape. */
function decodeRecord(
    obj: Record<string, unknown>,
    schema: SchemaMetadata,
    schemas: SchemaMap,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of schema.fields) {
        if (!(field.name in obj)) continue;
        out[field.name] = readJsonElement(obj[field.name], field.type, schemas);
    }
    return out;
}

/** When a value lives *inside* a JSON column (array or embedded), we keep it
 *  as a JSON-native primitive/object/array rather than its SQLite-bound form.
 *  e.g. nested booleans stay `true`/`false`, dates serialize to ISO strings. */
function prepareJsonElement(
    value: unknown,
    type: FieldType,
    schemas: SchemaMap,
): unknown {
    if (value === null || value === undefined) return value;
    switch (type.kind) {
        case "nullable":
            return prepareJsonElement(value, type.of, schemas);
        case "boolean":
            return value === true;
        case "bigint":
            return typeof value === "bigint" ? value.toString() : String(value);
        case "decimal":
            return String(value);
        case "date":
        case "dateTime":
        case "time":
            if (value instanceof Date) return value.toISOString();
            return value;
        case "bytes":
            if (value instanceof Uint8Array) {
                return Buffer.from(value).toString("base64");
            }
            return value;
        case "embedded": {
            const sub = schemas.get(type.schema);
            if (sub === undefined) return value;
            return encodeRecord(value as Record<string, unknown>, sub, schemas);
        }
        case "array":
            if (!Array.isArray(value)) return value;
            return value.map((v) => prepareJsonElement(v, type.of, schemas));
        default:
            return value;
    }
}

function readJsonElement(
    value: unknown,
    type: FieldType,
    schemas: SchemaMap,
): unknown {
    if (value === null || value === undefined) return value;
    switch (type.kind) {
        case "nullable":
            return readJsonElement(value, type.of, schemas);
        case "bigint":
            return typeof value === "string" ? BigInt(value) : value;
        case "date":
        case "dateTime":
        case "time":
            return typeof value === "string" ? new Date(value) : value;
        case "bytes":
            return typeof value === "string"
                ? new Uint8Array(Buffer.from(value, "base64"))
                : value;
        case "embedded": {
            const sub = schemas.get(type.schema);
            if (sub === undefined || typeof value !== "object") return value;
            return decodeRecord(value as Record<string, unknown>, sub, schemas);
        }
        case "array":
            if (!Array.isArray(value)) return value;
            return value.map((v) => readJsonElement(v, type.of, schemas));
        default:
            return value;
    }
}

/** Build the row to INSERT/UPDATE with: keys are schema field names, values are
 *  SQLite-bindable. Unknown fields in `data` are dropped. */
export function fromRecord(
    data: Record<string, unknown>,
    schema: SchemaMetadata,
    schemas: SchemaMap,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of schema.fields) {
        if (!(field.name in data)) continue;
        const v = data[field.name];
        if (v === undefined) continue;
        out[field.name] = toSqlite(v, field.type, schemas);
    }
    return out;
}

/** Decode a row coming back from SQLite into a Keyma record. */
export function toRecord(
    row: Record<string, unknown>,
    schema: SchemaMetadata,
    schemas: SchemaMap,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of schema.fields) {
        if (!(field.name in row)) continue;
        out[field.name] = fromSqlite(row[field.name], field.type, schemas);
    }
    return out;
}

/** Convert a literal value used in a filter (`$gt`, `$in`, etc.) to its
 *  SQLite-bindable form. Mirrors `toSqlite`, but `null` passes through (since
 *  `null` is a meaningful filter value). */
export function valueToSqlite(
    value: unknown,
    type: FieldType | undefined,
    schemas: SchemaMap,
): unknown {
    if (type === undefined) return value;
    return toSqlite(value, type, schemas);
}

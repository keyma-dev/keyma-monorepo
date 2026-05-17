import { Binary, Decimal128, ObjectId } from "mongodb";
import type { FieldType, SchemaMetadata } from "@keyma/runtime-js";

export type SchemaMap = ReadonlyMap<string, SchemaMetadata>;

export function encodeBigInt(value: bigint): Uint8Array {
    if (value === 0n) return new Uint8Array([0x00, 0x00]);
    const negative = value < 0n;
    let magnitude = negative ? -value : value;
    const bytes: number[] = [];
    while (magnitude > 0n) {
        bytes.push(Number(magnitude & 0xffn));
        magnitude >>= 8n;
    }
    bytes.reverse();
    return new Uint8Array([negative ? 0x01 : 0x00, ...bytes]);
}

export function decodeBigInt(bytes: Uint8Array): bigint {
    if (bytes.length === 0) return 0n;
    const sign = bytes[0] ?? 0;
    let magnitude = 0n;
    for (let i = 1; i < bytes.length; i++) {
        magnitude = (magnitude << 8n) | BigInt(bytes[i] ?? 0);
    }
    return sign === 0x01 ? -magnitude : magnitude;
}

export function toBson(value: unknown, type: FieldType, schemas: SchemaMap): unknown {
    if (value === null || value === undefined) return value;
    switch (type.kind) {
        case "nullable":
            return toBson(value, type.of, schemas);
        case "array":
            if (!Array.isArray(value)) return value;
            return value.map((v) => toBson(v, type.of, schemas));
        case "id":
            if (typeof value !== "string") return value;
            return new ObjectId(value);
        case "embedded": {
            const sub = schemas.get(type.schema);
            if (sub === undefined || typeof value !== "object") return value;
            return convertObjectToBson(value as Record<string, unknown>, sub, schemas);
        }
        case "reference":
            if (typeof value === "string") return new ObjectId(value);
            return value;
        case "bigint":
            if (typeof value !== "bigint") return value;
            return new Binary(encodeBigInt(value));
        case "decimal":
            if (value instanceof Decimal128) return value;
            return Decimal128.fromString(String(value));
        case "bytes":
            if (value instanceof Binary) return value;
            if (value instanceof Uint8Array) return new Binary(value);
            return value;
        case "dateTime":
            if (value instanceof Date) return value;
            if (typeof value === "string") return new Date(value);
            return value;
        default:
            return value;
    }
}

function convertObjectToBson(
    obj: Record<string, unknown>,
    schema: SchemaMetadata,
    schemas: SchemaMap,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of schema.fields) {
        if (!(field.name in obj)) continue;
        const value = obj[field.name];
        if (value === undefined) continue;
        out[field.name] = toBson(value, field.type, schemas);
    }
    return out;
}

export function fromBson(value: unknown, type: FieldType, schemas: SchemaMap): unknown {
    if (value === null || value === undefined) return value;
    switch (type.kind) {
        case "nullable":
            return fromBson(value, type.of, schemas);
        case "array":
            if (!Array.isArray(value)) return value;
            return value.map((v) => fromBson(v, type.of, schemas));
        case "id":
            if (value instanceof ObjectId) return value.toHexString();
            return value;
        case "embedded": {
            const sub = schemas.get(type.schema);
            if (sub === undefined || typeof value !== "object") return value;
            return toRecord(value as Record<string, unknown>, sub, schemas);
        }
        case "reference": {
            if (value instanceof ObjectId) return value.toHexString();
            if (typeof value !== "object" || value === null) return value;
            const sub = schemas.get(type.schema);
            if (sub === undefined) return value;
            return toRecord(value as Record<string, unknown>, sub, schemas);
        }
        case "bigint":
            if (value instanceof Binary) return decodeBigInt(value.buffer);
            return value;
        case "decimal":
            if (value instanceof Decimal128) return value.toString();
            return value;
        case "bytes":
            if (value instanceof Binary) return new Uint8Array(value.buffer);
            return value;
        default:
            return value;
    }
}

/** Convert a Keyma record into a BSON-ready document. Drops keys that aren't
 *  declared in the schema. Renames `id` → `_id`. */
export function fromRecord(
    data: Record<string, unknown>,
    schema: SchemaMetadata,
    schemas: SchemaMap,
    opts: { excludeId?: boolean } = {},
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of schema.fields) {
        if (!(field.name in data)) continue;
        const value = data[field.name];
        if (value === undefined) continue;
        const key = field.name === "id" ? "_id" : field.name;
        if (key === "_id" && opts.excludeId === true) continue;
        out[key] = toBson(value, field.type, schemas);
    }
    return out;
}

/** Convert a BSON document into a Keyma record. Renames `_id` → `id`. Recurses
 *  into populated references and embedded documents. */
export function toRecord(
    doc: Record<string, unknown>,
    schema: SchemaMetadata,
    schemas: SchemaMap,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of schema.fields) {
        const key = field.name === "id" ? "_id" : field.name;
        if (!(key in doc)) continue;
        out[field.name] = fromBson(doc[key], field.type, schemas);
    }
    return out;
}

/** Convert a Keyma-side value to its BSON representation for use in filter
 *  comparators (`$gt`, `$in`, etc). Schema-aware: needs the field's FieldType
 *  to know whether a literal should be wrapped in a Binary, Decimal128, etc. */
export function valueToBson(
    value: unknown,
    type: FieldType,
    schemas: SchemaMap,
): unknown {
    return toBson(value, type, schemas);
}

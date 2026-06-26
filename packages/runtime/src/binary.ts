// Binary wire codec — an alternative encoder of the same per-field data as `serialize`,
// parallel to JSON (see ../binary-format.md). `encodeBinary` mirrors `serialize.ts`'s
// per-field traversal (same type switch, same canonical conversions) but emits tag-keyed
// TLV tokens instead of building a name-keyed record; `bytes` stay raw (not base64).
// `decodeBinary` is the inverse, hydrating like `deserialize` (Date / Uint8Array /
// constructed sub-records). Field identity on the wire is `field.tag ?? declarationIndex+1`.

import type { SchemaMetadata, FieldType, FieldMetadata, SchemaClass } from "./types.js";
import type { SerializeTarget } from "./serialize.js";
import { allFields, allRefs } from "./fields.js";
import {
    writeVarint,
    readVarint,
    zigzagEncode,
    zigzagDecode,
    writeFloat32,
    writeFloat64,
    readFloat32,
    readFloat64,
} from "./varint.js";

// Wire types (the low 3 bits of each field key = tag * 8 + wiretype).
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_NULL = 3;
const WIRE_FIXED32 = 4;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

type Refs = ReadonlyMap<string, SchemaClass> | undefined;

// ── Encoding ────────────────────────────────────────────────────────────────

export function encodeBinary(
    schema: SchemaMetadata,
    value: Record<string, unknown>,
    opts: { target: SerializeTarget },
): Uint8Array {
    const out: number[] = [];
    encodeRecord(out, schema, value, opts);
    return Uint8Array.from(out);
}

function encodeRecord(
    out: number[],
    schema: SchemaMetadata,
    value: Record<string, unknown>,
    opts: { target: SerializeTarget },
): void {
    const fields = allFields(schema); // own + inherited, base-first (real inheritance)
    const refs = allRefs(schema);
    for (let i = 0; i < fields.length; i++) {
        const field = fields[i]!;
        if (opts.target === "client" && field.visibility === "private") continue;
        if (opts.target === "database" && field.ephemeral) continue;
        if (!(field.name in value)) continue;
        const fv = value[field.name];
        if (fv === undefined) continue; // mirrors JSON.stringify dropping `undefined`
        const tag = field.tag ?? i + 1;
        if (fv === null) {
            writeKey(out, tag, WIRE_NULL);
            continue;
        }
        writeKey(out, tag, wiretypeOf(field.type));
        encodePayload(out, field.type, fv, refs, opts);
    }
}

function writeKey(out: number[], tag: number, wiretype: number): void {
    writeVarint(out, tag * 8 + wiretype);
}

function wiretypeOf(type: FieldType): number {
    switch (type.kind) {
        case "boolean":
        case "integer":
        case "bigint":
        case "dateTime":
            return WIRE_VARINT;
        case "number":
            return type.bits === 32 ? WIRE_FIXED32 : WIRE_FIXED64;
        case "reference":
            return type.idType?.kind === "integer" ? WIRE_VARINT : WIRE_LENGTH;
        default:
            // string, id, enum, date, time, decimal, bytes, embedded, array, json
            return WIRE_LENGTH;
    }
}

function encodePayload(out: number[], type: FieldType, value: unknown, refs: Refs, opts: { target: SerializeTarget }): void {
    switch (type.kind) {
        case "boolean":
            writeVarint(out, value ? 1 : 0);
            return;
        case "integer":
            writeVarint(out, type.unsigned ? toBig(value) : zigzagEncode(toBig(value)));
            return;
        case "bigint":
            writeVarint(out, zigzagEncode(toBig(value)));
            return;
        case "dateTime": {
            const ms = value instanceof Date ? value.getTime() : Number(value);
            writeVarint(out, zigzagEncode(BigInt(ms)));
            return;
        }
        case "number":
            if (type.bits === 32) writeFloat32(out, Number(value));
            else writeFloat64(out, Number(value));
            return;
        case "string":
        case "id":
        case "enum":
        case "date":
        case "time":
        case "decimal":
            writeLengthBytes(out, utf8Encoder.encode(String(value)));
            return;
        case "bytes":
            writeLengthBytes(out, value instanceof Uint8Array ? value : new Uint8Array(0));
            return;
        case "embedded": {
            const sub = refs?.get(type.schema);
            const body: number[] = [];
            if (sub !== undefined && isRecord(value)) {
                encodeRecord(body, sub.schema, value, opts);
            }
            writeLengthBody(out, body);
            return;
        }
        case "reference": {
            const id = refIdOf(value);
            if (type.idType?.kind === "integer") {
                writeVarint(out, type.idType.unsigned ? toBig(id) : zigzagEncode(toBig(id)));
            } else {
                writeLengthBytes(out, utf8Encoder.encode(String(id)));
            }
            return;
        }
        case "array": {
            const arr = Array.isArray(value) ? value : [];
            const body: number[] = [];
            writeVarint(body, arr.length);
            for (const el of arr) encodeElement(body, type.of, el, refs, opts);
            writeLengthBody(out, body);
            return;
        }
        case "json": {
            const body: number[] = [];
            encodeJson(body, value);
            writeLengthBody(out, body);
            return;
        }
        default:
            writeLengthBytes(out, utf8Encoder.encode(String(value)));
    }
}

// An array element token: a standalone 1-byte wiretype then payload (no tag).
function encodeElement(out: number[], type: FieldType, value: unknown, refs: Refs, opts: { target: SerializeTarget }): void {
    if (value === null || value === undefined) {
        out.push(WIRE_NULL);
        return;
    }
    out.push(wiretypeOf(type));
    encodePayload(out, type, value, refs, opts);
}

function writeLengthBytes(out: number[], bytes: Uint8Array): void {
    writeVarint(out, bytes.length);
    for (let i = 0; i < bytes.length; i++) out.push(bytes[i]!);
}
function writeLengthBody(out: number[], body: number[]): void {
    writeVarint(out, body.length);
    for (let i = 0; i < body.length; i++) out.push(body[i]!);
}

// Self-describing generic encoding for `json` fields (kind tag + payload).
const JSON_NULL = 0, JSON_FALSE = 1, JSON_TRUE = 2, JSON_INT = 3, JSON_FLOAT = 4,
    JSON_STRING = 5, JSON_ARRAY = 6, JSON_OBJECT = 7, JSON_BYTES = 8;

function encodeJson(out: number[], value: unknown): void {
    if (value === null || value === undefined) {
        out.push(JSON_NULL);
        return;
    }
    switch (typeof value) {
        case "boolean":
            out.push(value ? JSON_TRUE : JSON_FALSE);
            return;
        case "number":
            if (Number.isInteger(value)) {
                out.push(JSON_INT);
                writeVarint(out, zigzagEncode(BigInt(value)));
            } else {
                out.push(JSON_FLOAT);
                writeFloat64(out, value);
            }
            return;
        case "bigint":
            out.push(JSON_INT);
            writeVarint(out, zigzagEncode(value));
            return;
        case "string":
            out.push(JSON_STRING);
            writeLengthBytes(out, utf8Encoder.encode(value));
            return;
        case "object": {
            if (value instanceof Uint8Array) {
                out.push(JSON_BYTES);
                writeLengthBytes(out, value);
                return;
            }
            if (Array.isArray(value)) {
                out.push(JSON_ARRAY);
                writeVarint(out, value.length);
                for (const el of value) encodeJson(out, el);
                return;
            }
            const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
            out.push(JSON_OBJECT);
            writeVarint(out, entries.length);
            for (const [k, v] of entries) {
                writeLengthBytes(out, utf8Encoder.encode(k));
                encodeJson(out, v);
            }
            return;
        }
        default:
            out.push(JSON_NULL); // function/symbol → null
    }
}

function toBig(value: unknown): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(Math.trunc(value));
    return BigInt(value as string | number);
}

function refIdOf(value: unknown): unknown {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return (value as Record<string, unknown>)["id"];
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Date) &&
        !(value instanceof Uint8Array)
    );
}

// ── Decoding ────────────────────────────────────────────────────────────────

type Reader = { buf: Uint8Array; pos: number; end: number };

export function decodeBinary(schema: SchemaMetadata, bytes: Uint8Array): Record<string, unknown> {
    return decodeRecord(schema, { buf: bytes, pos: 0, end: bytes.length });
}

function decodeRecord(schema: SchemaMetadata, r: Reader): Record<string, unknown> {
    const byTag = fieldsByTag(schema);
    const refs = allRefs(schema); // own + inherited targets (real inheritance)
    const out: Record<string, unknown> = {};
    while (r.pos < r.end) {
        const key = readVarintBig(r);
        const tag = Number(key >> 3n);
        const wiretype = Number(key & 7n);
        const field = byTag.get(tag);
        if (field === undefined) {
            skipValue(r, wiretype);
            continue;
        }
        if (wiretype === WIRE_NULL) {
            out[field.name] = null;
            continue;
        }
        out[field.name] = decodeValue(r, field.type, wiretype, refs);
    }
    return out;
}

function fieldsByTag(schema: SchemaMetadata): Map<number, FieldMetadata> {
    const m = new Map<number, FieldMetadata>();
    allFields(schema).forEach((f, i) => m.set(f.tag ?? i + 1, f)); // own + inherited (real inheritance)
    return m;
}

function decodeValue(r: Reader, type: FieldType, wiretype: number, refs: Refs): unknown {
    switch (type.kind) {
        case "boolean":
            return readVarintBig(r) !== 0n;
        case "integer":
            return Number(type.unsigned ? readVarintBig(r) : zigzagDecode(readVarintBig(r)));
        case "bigint":
            return zigzagDecode(readVarintBig(r));
        case "dateTime":
            return new Date(Number(zigzagDecode(readVarintBig(r))));
        case "number": {
            const val = wiretype === WIRE_FIXED32 ? readFloat32(r.buf, r.pos) : readFloat64(r.buf, r.pos);
            r.pos += wiretype === WIRE_FIXED32 ? 4 : 8;
            return val;
        }
        case "string":
        case "id":
        case "enum":
        case "date":
        case "time":
        case "decimal":
            return utf8Decoder.decode(readLengthBytes(r));
        case "bytes":
            return new Uint8Array(readLengthBytes(r));
        case "embedded": {
            const inner = readLengthWindow(r);
            const sub = refs?.get(type.schema);
            if (sub === undefined) return decodeUnknownRecord(inner);
            const rec = decodeRecord(sub.schema, inner);
            return construct(sub, rec);
        }
        case "reference": {
            if (type.idType?.kind === "integer") {
                return Number(type.idType.unsigned ? readVarintBig(r) : zigzagDecode(readVarintBig(r)));
            }
            return utf8Decoder.decode(readLengthBytes(r));
        }
        case "array": {
            const inner = readLengthWindow(r);
            const count = Number(readVarintBig(inner));
            const result: unknown[] = [];
            for (let i = 0; i < count; i++) {
                const ewt = inner.buf[inner.pos++];
                if (ewt === undefined) throw new RangeError("decodeBinary: truncated array element");
                if (ewt === WIRE_NULL) {
                    result.push(null);
                    continue;
                }
                result.push(decodeValue(inner, type.of, ewt, refs));
            }
            return result;
        }
        case "json":
            return decodeJson(readLengthWindow(r));
        default:
            skipValue(r, wiretype);
            return undefined;
    }
}

function decodeJson(r: Reader): unknown {
    const kind = r.buf[r.pos++];
    switch (kind) {
        case JSON_NULL:
            return null;
        case JSON_FALSE:
            return false;
        case JSON_TRUE:
            return true;
        case JSON_INT:
            return Number(zigzagDecode(readVarintBig(r)));
        case JSON_FLOAT: {
            const val = readFloat64(r.buf, r.pos);
            r.pos += 8;
            return val;
        }
        case JSON_STRING:
            return utf8Decoder.decode(readLengthBytes(r));
        case JSON_BYTES:
            return new Uint8Array(readLengthBytes(r));
        case JSON_ARRAY: {
            const count = Number(readVarintBig(r));
            const arr: unknown[] = [];
            for (let i = 0; i < count; i++) arr.push(decodeJson(r));
            return arr;
        }
        case JSON_OBJECT: {
            const count = Number(readVarintBig(r));
            const obj: Record<string, unknown> = {};
            for (let i = 0; i < count; i++) {
                const k = utf8Decoder.decode(readLengthBytes(r));
                obj[k] = decodeJson(r);
            }
            return obj;
        }
        default:
            throw new RangeError("decodeBinary: unknown json kind " + kind);
    }
}

function skipValue(r: Reader, wiretype: number): void {
    switch (wiretype) {
        case WIRE_VARINT:
            readVarintBig(r);
            return;
        case WIRE_FIXED64:
            r.pos += 8;
            return;
        case WIRE_FIXED32:
            r.pos += 4;
            return;
        case WIRE_LENGTH: {
            const len = Number(readVarintBig(r));
            r.pos += len;
            return;
        }
        case WIRE_NULL:
            return;
        default:
            throw new RangeError("decodeBinary: unknown wiretype " + wiretype);
    }
}

function readVarintBig(r: Reader): bigint {
    const [val, next] = readVarint(r.buf, r.pos);
    r.pos = next;
    return val;
}
function readLengthBytes(r: Reader): Uint8Array {
    const len = Number(readVarintBig(r));
    const slice = r.buf.subarray(r.pos, r.pos + len);
    r.pos += len;
    return slice;
}
function readLengthWindow(r: Reader): Reader {
    const len = Number(readVarintBig(r));
    const start = r.pos;
    r.pos += len;
    return { buf: r.buf, pos: start, end: start + len };
}

function construct(cls: SchemaClass, rec: Record<string, unknown>): unknown {
    return new (cls as unknown as new (value?: unknown) => unknown)(rec);
}

// Decode a sub-record whose schema (ref) is unavailable: keep going so the outer record
// stays parseable, but values cannot be typed — return the raw key→null shells is wrong, so
// return an empty object (the window has already been consumed by the caller).
function decodeUnknownRecord(_inner: Reader): Record<string, unknown> {
    return {};
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeBinary, decodeBinary } from "../src/binary.js";
import type { ClassMeta, ClassRef, FieldMeta } from "../src/fields.js";
import { defineClass } from "./helpers.js";

// The canonical cross-runtime fixtures live here; the Python and C++ runtime suites read the
// SAME file and assert byte-identical output. Regenerate with
// `UPDATE_BINARY_FIXTURES=1 npm -w @keyma/runtime test` after an intentional format change.
//
// NB — the codec is now target-free + visibility-blind (no `SerializeTarget`). The reference/
// embedded field descriptors carry the target class identity under `target` (the emitted
// `ClassMetadata` shape), not the legacy `schema`. The wire BYTES are unchanged for every
// previously-`server`-target fixture; the lone visibility fixture now encodes its private field
// (visibility is purely the compile-time bundle split), so only that fixture's bytes differ.
const FIXTURES_PATH = fileURLToPath(new URL("../../test/binary-fixtures.json", import.meta.url));

// ── Fixture definitions (native JS records; the source of truth for the committed file) ──

type ClassMetaLite = {
    name: string;
    sourceName: string;
    fields: FieldMeta[];
};

type Fixture = {
    name: string;
    schema: ClassMetaLite;
    /** Sub-classes for embedded fields, keyed by class `name`. */
    schemas?: Record<string, ClassMetaLite>;
    record: Record<string, unknown>;
};

const FIXTURES: Fixture[] = [
    {
        name: "scalars",
        schema: {
            name: "scalars",
            sourceName: "Scalars",
            fields: [
                { name: "id", type: { kind: "id" } },
                { name: "title", type: { kind: "string" } },
                { name: "count", type: { kind: "integer" } },
                { name: "negative", type: { kind: "integer" } },
                { name: "size", type: { kind: "integer", unsigned: true } },
                { name: "active", type: { kind: "boolean" } },
                { name: "inactive", type: { kind: "boolean" } },
                { name: "ratio", type: { kind: "number" } },
                { name: "single", type: { kind: "number", bits: 32 } },
                { name: "created", type: { kind: "dateTime" } },
                { name: "blob", type: { kind: "bytes" } },
                { name: "status", type: { kind: "enum", values: ["active", "inactive"] } },
                { name: "price", type: { kind: "decimal" } },
                { name: "day", type: { kind: "date" } },
                { name: "moment", type: { kind: "time" } },
                { name: "big", type: { kind: "bigint" } },
            ],
        },
        record: {
            id: "u1",
            title: "héllo",
            count: 300,
            negative: -7,
            size: 4096,
            active: true,
            inactive: false,
            ratio: 3.5,
            single: 1.5,
            created: new Date("2024-01-02T03:04:05.000Z"),
            blob: new Uint8Array([0, 1, 2, 253, 254, 255]),
            status: "active",
            price: "19.99",
            day: "2024-06-25",
            moment: "13:45:00",
            big: 9007199254740993n,
        },
    },
    {
        name: "integer-widths",
        schema: {
            name: "widths",
            sourceName: "Widths",
            fields: [
                { name: "i8", type: { kind: "integer", bits: 8 } },
                { name: "i16", type: { kind: "integer", bits: 16 } },
                { name: "i32", type: { kind: "integer", bits: 32 } },
                { name: "i64", type: { kind: "integer", bits: 64 } },
                { name: "u8", type: { kind: "integer", bits: 8, unsigned: true } },
                { name: "u16", type: { kind: "integer", bits: 16, unsigned: true } },
                { name: "u32", type: { kind: "integer", bits: 32, unsigned: true } },
                { name: "u64", type: { kind: "integer", bits: 64, unsigned: true } },
            ],
        },
        // Same magnitude under every signed width → identical varint bytes (bits is range-only).
        record: { i8: 42, i16: 42, i32: 42, i64: 42, u8: 42, u16: 42, u32: 42, u64: 42 },
    },
    {
        name: "nullable-and-absent",
        schema: {
            name: "optionals",
            sourceName: "Optionals",
            fields: [
                { name: "id", type: { kind: "id" } },
                { name: "present", type: { kind: "string" } },
                { name: "explicitNull", type: { kind: "string" } },
                { name: "absent", type: { kind: "string" } },
            ],
        },
        // `explicitNull` present-and-null → NULL token; `absent` omitted entirely.
        record: { id: "x", present: "here", explicitNull: null },
    },
    {
        name: "arrays",
        schema: {
            name: "lists",
            sourceName: "Lists",
            fields: [
                { name: "tags", type: { kind: "array", of: { kind: "string" } } },
                { name: "nums", type: { kind: "array", of: { kind: "integer" } } },
                { name: "empty", type: { kind: "array", of: { kind: "string" } } },
                { name: "sparse", type: { kind: "array", of: { kind: "string" }, elementNullable: true } },
            ],
        },
        record: { tags: ["a", "bb", "ccc"], nums: [1, -2, 300], empty: [], sparse: ["x", null, "z"] },
    },
    {
        name: "references",
        schema: {
            name: "refs",
            sourceName: "Refs",
            fields: [
                { name: "author", type: { kind: "reference", target: "User", idType: { kind: "id" } } },
                { name: "owner", type: { kind: "reference", target: "Account", idType: { kind: "integer" } } },
                { name: "wrapped", type: { kind: "reference", target: "User", idType: { kind: "string" } } },
            ],
        },
        // Bare id, integer id, and an `{id}` wrapper that collapses to its id.
        record: { author: "author-1", owner: 1234, wrapped: { id: "author-2" } },
    },
    {
        name: "embedded",
        schema: {
            name: "outer",
            sourceName: "Outer",
            fields: [
                { name: "id", type: { kind: "id" } },
                { name: "address", type: { kind: "embedded", target: "Address" } },
            ],
        },
        schemas: {
            Address: {
                name: "Address",
                sourceName: "Address",
                fields: [
                    { name: "street", type: { kind: "string" } },
                    { name: "zip", type: { kind: "string" } },
                ],
            },
        },
        record: { id: "o1", address: { street: "1 Main", zip: "00000" } },
    },
    {
        name: "visibility-blind",
        schema: {
            name: "user",
            sourceName: "User",
            fields: [
                { name: "id", type: { kind: "id" } },
                { name: "email", type: { kind: "string" } },
                // Visibility-blind: a (would-be private) field is encoded like any other.
                { name: "secret", type: { kind: "string" } },
            ],
        },
        record: { id: "u1", email: "a@b.com", secret: "x" },
    },
];

// ── Wire <-> native conversion for the committed (JSON) fixture file ──

function bytesToHex(b: Uint8Array): string {
    let s = "";
    for (const x of b) s += x.toString(16).padStart(2, "0");
    return s;
}
function hexToBytes(h: string): Uint8Array {
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function toWire(v: unknown): unknown {
    if (v instanceof Date) return { $date: v.getTime() };
    if (v instanceof Uint8Array) return { $bytes: bytesToHex(v) };
    if (typeof v === "bigint") return { $bigint: v.toString() };
    if (Array.isArray(v)) return v.map(toWire);
    if (v !== null && typeof v === "object") {
        const o: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = toWire(x);
        return o;
    }
    return v;
}
function fromWire(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(fromWire);
    if (v !== null && typeof v === "object") {
        const obj = v as Record<string, unknown>;
        if ("$date" in obj) return new Date(obj["$date"] as number);
        if ("$bytes" in obj) return hexToBytes(obj["$bytes"] as string);
        if ("$bigint" in obj) return BigInt(obj["$bigint"] as string);
        const o: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(obj)) o[k] = fromWire(x);
        return o;
    }
    return v;
}

// Rebuild a ClassMeta (with a `refs` Map of stub model classes) from plain metadata — the same
// revival the Python/C++ loaders perform from the shared file. All sub-classes share one `refs`
// map so multi-level embedding resolves without re-revival.
function reviveSchema(meta: ClassMetaLite, schemas: Record<string, ClassMetaLite> | undefined): ClassMeta {
    const refs = new Map<string, ClassRef>();
    for (const [name, sub] of Object.entries(schemas ?? {})) {
        const subMeta: ClassMeta = { ...sub, refs };
        refs.set(name, defineClass(subMeta));
    }
    return { ...meta, refs };
}

function encodeHex(f: { schema: ClassMetaLite; schemas?: Record<string, ClassMetaLite> | undefined; record: Record<string, unknown> }): string {
    return bytesToHex(encodeBinary(reviveSchema(f.schema, f.schemas), f.record));
}

// Regenerate the committed file from the native fixtures when asked (or to bootstrap it).
if (process.env["UPDATE_BINARY_FIXTURES"] || !existsSync(FIXTURES_PATH)) {
    const wire = FIXTURES.map((f) => ({
        name: f.name,
        schema: f.schema,
        ...(f.schemas ? { schemas: f.schemas } : {}),
        record: toWire(f.record),
        hex: encodeHex(f),
    }));
    writeFileSync(FIXTURES_PATH, JSON.stringify({ format: "keyma-binary", version: "1", fixtures: wire }, null, 2) + "\n");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

type CommittedFixture = {
    name: string;
    schema: ClassMetaLite;
    schemas?: Record<string, ClassMetaLite>;
    record: Record<string, unknown>;
    hex: string;
};

describe("binary parity fixtures", () => {
    const committed = JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as { fixtures: CommittedFixture[] };

    for (const cf of committed.fixtures) {
        it(`encodes "${cf.name}" to the committed hex`, () => {
            const record = fromWire(cf.record) as Record<string, unknown>;
            assert.equal(encodeHex({ schema: cf.schema, schemas: cf.schemas, record }), cf.hex);
        });
    }
});

describe("binary round-trip", () => {
    for (const f of FIXTURES) {
        it(`round-trips "${f.name}" through decode`, () => {
            const schema = reviveSchema(f.schema, f.schemas);
            const decoded = decodeBinary(schema, encodeBinary(schema, f.record));

            for (const field of f.schema.fields) {
                const present = field.name in f.record && f.record[field.name] !== undefined;
                if (!present) {
                    assert.ok(!(field.name in decoded), `${field.name} should be absent`);
                    continue;
                }
                assertFieldEqual(field, f.record[field.name], decoded[field.name]);
            }
        });
    }

    function assertFieldEqual(field: FieldMeta, original: unknown, decoded: unknown): void {
        if (original === null) {
            assert.equal(decoded, null);
            return;
        }
        switch (field.type.kind) {
            case "dateTime":
                assert.ok(decoded instanceof Date);
                assert.equal((decoded as Date).getTime(), (original as Date).getTime());
                return;
            case "bytes":
                assert.deepEqual(Array.from(decoded as Uint8Array), Array.from(original as Uint8Array));
                return;
            case "reference":
                // `{id}` wrappers collapse to the bare id on the wire.
                assert.equal(decoded, refId(original));
                return;
            case "embedded":
                assert.deepEqual({ ...(decoded as object) }, original);
                return;
            default:
                assert.deepEqual(decoded, original);
        }
    }
    function refId(v: unknown): unknown {
        return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)["id"] : v;
    }
});

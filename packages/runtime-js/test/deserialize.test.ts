import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deserialize } from "../src/deserialize.js";
import type { SchemaMetadata, SchemaClass } from "../src/types.js";
import { brandSchema } from "../src/brand.js";

// ─── Reusable mini-schemas ───────────────────────────────────────────────────

interface InnerRecord {
    label: string;
    when: Date;
}

class InnerCtor {
    declare label: string;
    declare when: Date;
    constructor(value?: Partial<InnerRecord>) {
        if (value) Object.assign(this, value);
    }
}

const INNER_SCHEMA: SchemaMetadata = {
    name: "inner",
    sourceName: "Inner",
    fields: [
        { name: "label", type: { kind: "string" } },
        { name: "when", type: { kind: "dateTime" }, required: false },
    ],
};

const Inner: SchemaClass<InnerRecord> = brandSchema(
    InnerCtor as new (value?: Partial<InnerRecord>) => InnerRecord,
    INNER_SCHEMA,
);

interface RefRecord {
    id: string;
    label: string;
}

class RefCtor {
    declare id: string;
    declare label: string;
    constructor(value?: Partial<RefRecord>) {
        if (value) Object.assign(this, value);
    }
}

const REF_SCHEMA: SchemaMetadata = {
    name: "ref",
    sourceName: "Ref",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "label", type: { kind: "string" } },
    ],
};

const Ref: SchemaClass<RefRecord> = brandSchema(
    RefCtor as new (value?: Partial<RefRecord>) => RefRecord,
    REF_SCHEMA,
);

function withRefs(fields: SchemaMetadata["fields"]): SchemaMetadata {
    return {
        name: "outer",
        sourceName: "Outer",
        fields,
        refs: new Map<string, SchemaClass>([
            ["inner", Inner],
            ["ref", Ref],
        ]),
    };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("deserialize", () => {
    it("converts dateTime ISO strings to Date", () => {
        const schema = withRefs([{ name: "when", type: { kind: "dateTime" } }]);
        const iso = "2024-01-02T03:04:05.000Z";
        const out = deserialize(schema, { when: iso });
        assert.ok(out["when"] instanceof Date);
        assert.equal((out["when"] as Date).toISOString(), iso);
    });

    it("passes null/undefined through a nullable dateTime", () => {
        const schema = withRefs([
            {
                name: "when",
                type: { kind: "dateTime" },
                nullable: true,
                required: false,
            },
        ]);
        assert.equal(deserialize(schema, { when: null })["when"], null);
        assert.equal(deserialize(schema, { when: undefined })["when"], undefined);
    });

    it("converts every element in an array of dateTime", () => {
        const schema = withRefs([
            { name: "stamps", type: { kind: "array", of: { kind: "dateTime" } } },
        ]);
        const out = deserialize(schema, {
            stamps: ["2024-01-01T00:00:00.000Z", "2024-02-02T00:00:00.000Z"],
        });
        const stamps = out["stamps"] as unknown[];
        assert.ok(stamps[0] instanceof Date);
        assert.ok(stamps[1] instanceof Date);
    });

    it("instantiates embedded subobjects via refs and recurses into them", () => {
        const schema = withRefs([
            { name: "inner", type: { kind: "embedded", schema: "inner" } },
        ]);
        const out = deserialize(schema, {
            inner: { label: "hi", when: "2024-01-02T03:04:05.000Z" },
        });
        assert.ok(out["inner"] instanceof Inner);
        const inner = out["inner"] as InnerRecord;
        assert.equal(inner.label, "hi");
        assert.ok(inner.when instanceof Date);
    });

    it("constructs a stub reference instance from a bare ID string", () => {
        const schema = withRefs([
            { name: "ref", type: { kind: "reference", schema: "ref" } },
        ]);
        const out = deserialize(schema, { ref: "r1" });
        assert.ok(out["ref"] instanceof Ref);
        const ref = out["ref"] as RefRecord;
        assert.equal(ref.id, "r1");
        assert.equal(ref.label, undefined);
    });

    it("fully constructs a populated reference object", () => {
        const schema = withRefs([
            { name: "ref", type: { kind: "reference", schema: "ref" } },
        ]);
        const out = deserialize(schema, { ref: { id: "r1", label: "hello" } });
        assert.ok(out["ref"] instanceof Ref);
        const ref = out["ref"] as RefRecord;
        assert.equal(ref.id, "r1");
        assert.equal(ref.label, "hello");
    });

    it("leaves values untouched when refs map is absent", () => {
        const schema: SchemaMetadata = {
            name: "outer",
            sourceName: "Outer",
            fields: [
                { name: "inner", type: { kind: "embedded", schema: "inner" } },
                { name: "ref", type: { kind: "reference", schema: "ref" } },
            ],
        };
        const out = deserialize(schema, {
            inner: { label: "hi" },
            ref: "r1",
        });
        assert.deepEqual(out["inner"], { label: "hi" });
        assert.equal(out["ref"], "r1");
    });

    it("omits fields missing from input rather than setting them to undefined", () => {
        const schema = withRefs([
            { name: "label", type: { kind: "string" } },
            { name: "when", type: { kind: "dateTime" }, required: false },
        ]);
        const out = deserialize(schema, { label: "only" });
        assert.deepEqual(Object.keys(out), ["label"]);
        assert.equal("when" in out, false);
    });
});

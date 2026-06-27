import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual, KEYMA010, KEYMA025, KEYMA071, KEYMA099 } from "../../src/frontend-ts/index.js";
import type { IRClassDeclaration } from "@keyma/core/ir";

// The generic TS-type → IR-type mapper is domain-neutral: every in-project class is lowered with no
// domains registered, so the base field types (scalars, arrays, enums, numeric widths, ownership
// kinds) are observed straight off `ir.classes`. The schema-only enrichment (a reference's `idType`,
// validators/indexes) is NOT present here — that is the point of testing the base mapping in isolation.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(__dirname, "..", "..", "src", "frontend-ts");

function cv(sources: Record<string, string>) {
    return compileVirtual(sources, { baseDir: BASE });
}
const errorCodes = (r: ReturnType<typeof cv>) => r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
const hasError = (r: ReturnType<typeof cv>, code: string) => r.diagnostics.some((d) => d.code === code && d.severity === "error");

function classOf(r: ReturnType<typeof cv>, sourceName: string): IRClassDeclaration {
    const s = r.ir.classes.find((x) => x.sourceName === sourceName);
    assert.ok(s !== undefined, `class ${sourceName} not found`);
    return s!;
}

describe("base field-type mapping — all types", () => {
    const r = cv({
        "all-types.ts": `
            import type { ID, DateOnly, DateTime, TimeOfDay, Decimal, Json, Bytes, Nullable, Reference, Embedded } from "@keyma/core/dsl";
            class Address { declare id: ID; declare street: string; }
            class AllTypes {
                declare id: ID;
                declare name: string;
                declare count: number;
                declare flag: boolean;
                declare big: bigint;
                declare date: DateOnly;
                declare ts: DateTime;
                declare time: TimeOfDay;
                declare money: Decimal;
                declare blob: Bytes;
                declare meta: Json;
                declare tags: string[];
                declare status: "draft" | "published" | "archived";
                declare maybe?: string;
                declare nullableStr: string | null;
                declare addr: Reference<Address>;
                declare embedded: Embedded<Address>;
                declare nullableRef: Nullable<Reference<Address>>;
            }
        `,
    });

    it("produces no errors", () => {
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
    });

    it("maps all scalar types", () => {
        const f = (n: string) => classOf(r, "AllTypes").fields.find((x) => x.name === n)!;
        assert.deepEqual(f("id").type, { kind: "id" });
        assert.deepEqual(f("name").type, { kind: "string" });
        assert.deepEqual(f("count").type, { kind: "number" });
        assert.deepEqual(f("flag").type, { kind: "boolean" });
        assert.deepEqual(f("big").type, { kind: "bigint" });
        assert.deepEqual(f("date").type, { kind: "date" });
        assert.deepEqual(f("ts").type, { kind: "dateTime" });
        assert.deepEqual(f("time").type, { kind: "time" });
        assert.deepEqual(f("money").type, { kind: "decimal" });
        assert.deepEqual(f("blob").type, { kind: "bytes" });
        assert.deepEqual(f("meta").type, { kind: "json" });
    });

    it("maps array, enum, nullable/optional, and ownership types (no schema idType enrichment)", () => {
        const f = (n: string) => classOf(r, "AllTypes").fields.find((x) => x.name === n)!;
        assert.deepEqual(f("tags").type, { kind: "array", of: { kind: "string" } });
        assert.deepEqual(f("status").type, { kind: "enum", values: ["draft", "published", "archived"] });

        assert.deepEqual(f("maybe").type, { kind: "string" });
        assert.equal(f("maybe").required, false);
        assert.equal(f("maybe").nullable, undefined);

        assert.deepEqual(f("nullableStr").type, { kind: "string" });
        assert.equal(f("nullableStr").nullable, true);
        assert.equal(f("nullableStr").required, true);

        // The base reference/embedded mapping carries only `target` (lowercased canonical name);
        // the `idType` is a schema-domain enrichment, absent with no domains.
        assert.deepEqual(f("addr").type, { kind: "reference", target: "address" });
        assert.deepEqual(f("embedded").type, { kind: "embedded", target: "address" });

        assert.deepEqual(f("nullableRef").type, { kind: "reference", target: "address" });
        assert.equal(f("nullableRef").nullable, true);
    });
});

describe("base field-type mapping — numeric widths", () => {
    const r = cv({
        "numeric-types.ts": `
            import type { ID, Integer, Unsigned, Float } from "@keyma/core/dsl";
            class NumericTypes {
                declare id: ID;
                declare i8: Integer<8>;
                declare i16: Integer<16>;
                declare i32: Integer<32>;
                declare i64: Integer;
                declare u8: Unsigned<8>;
                declare u32: Unsigned<32>;
                declare u64: Unsigned;
                declare f: Float;
                declare f32: Float<32>;
                declare ints: Integer<16>[];
                declare maybeBig?: Unsigned<64>;
            }
        `,
    });

    it("lowers Integer/Unsigned/Float widths, omitting bits at the default (64)", () => {
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        const f = (n: string) => classOf(r, "NumericTypes").fields.find((x) => x.name === n)!;
        assert.deepEqual(f("i8").type, { kind: "integer", bits: 8 });
        assert.deepEqual(f("i16").type, { kind: "integer", bits: 16 });
        assert.deepEqual(f("i32").type, { kind: "integer", bits: 32 });
        assert.deepEqual(f("i64").type, { kind: "integer" });
        assert.deepEqual(f("u8").type, { kind: "integer", bits: 8, unsigned: true });
        assert.deepEqual(f("u32").type, { kind: "integer", bits: 32, unsigned: true });
        assert.deepEqual(f("u64").type, { kind: "integer", unsigned: true });
        assert.deepEqual(f("f").type, { kind: "number" });
        assert.deepEqual(f("f32").type, { kind: "number", bits: 32 });
    });

    it("recurses through array and optional positions", () => {
        const f = (n: string) => classOf(r, "NumericTypes").fields.find((x) => x.name === n)!;
        assert.deepEqual(f("ints").type, { kind: "array", of: { kind: "integer", bits: 16 } });
        assert.deepEqual(f("maybeBig").type, { kind: "integer", unsigned: true });
        assert.equal(f("maybeBig").required, false);
    });
});

describe("type-mapping diagnostics", () => {
    it("KEYMA099 — invalid Integer width", () => {
        assert.ok(hasError(cv({ "s.ts": `import type { Integer } from "@keyma/core/dsl"; class Foo { declare bad: Integer<7>; }` }), KEYMA099));
    });
    it("KEYMA099 — invalid Float width", () => {
        assert.ok(hasError(cv({ "s.ts": `import type { Float } from "@keyma/core/dsl"; class Foo { declare bad: Float<16>; }` }), KEYMA099));
    });
    it("KEYMA010 — unresolvable type", () => {
        assert.ok(hasError(cv({ "s.ts": `class Foo { declare bar: SomeUnknownType; }` }), KEYMA010));
    });
    it("KEYMA071 — a bare class field must be Reference<T>/Embedded<T>", () => {
        assert.ok(hasError(cv({ "s.ts": `class A { declare x: string; } class B { declare a: A; }` }), KEYMA071));
    });
    it("KEYMA025 — a non-portable (numeric) enum is rejected", () => {
        assert.ok(hasError(cv({ "s.ts": `enum Level { Low, High } class Foo { declare level: Level; }` }), KEYMA025));
    });
});

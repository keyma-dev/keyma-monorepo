import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual, KEYMA040, KEYMA090, KEYMA098 } from "../../src/frontend-ts/index.js";
import type { IRClassDeclaration } from "@keyma/core/ir";

// The per-class base-IR build (member collision checks, getter/setter behaviors, initializer
// defaults, named-enum recognition, IR envelope) is domain-neutral — every class is lowered with no
// domains registered.

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

describe("KEYMA040 — duplicate member name", () => {
    it("flags two fields of the same name", () => {
        assert.ok(hasError(cv({ "s.ts": `class Foo { declare name: string; declare name: number; }` }), KEYMA040));
    });
    it("flags a method whose name collides with a field", () => {
        assert.ok(hasError(cv({ "s.ts": `class Foo { declare name: string; name(): string { return this.name; } }` }), KEYMA040));
    });
    it("flags a getter whose name collides with a stored field", () => {
        assert.ok(hasError(cv({ "s.ts": `class Foo { declare name: string; get name(): string { return "x"; } }` }), KEYMA040));
    });
    it("flags two getters of the same name", () => {
        assert.ok(hasError(cv({ "s.ts": `class Foo { declare a: string; get dup(): string { return this.a; } get dup(): string { return this.a; } }` }), KEYMA040));
    });
});

describe("getters & setters are behaviors, not fields", () => {
    it("lowers an undecorated getter as a getter behavior (no field, no KEYMA098)", () => {
        const r = cv({ "s.ts": `class Foo { declare first: string; get shout(): string { return this.first; } }` });
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        const foo = classOf(r, "Foo");
        assert.equal(foo.fields.find((f) => f.name === "shout"), undefined, "getter must not be a field");
        assert.ok((foo.methods ?? []).some((m) => m.name === "shout" && m.kind === "getter"));
        assert.ok(!r.diagnostics.some((d) => d.code === KEYMA098));
    });

    it("accepts a getter/setter pair of the same name (both behaviors)", () => {
        const r = cv({ "s.ts": `class Foo { declare firstName: string; get name(): string { return this.firstName; } set name(v: string) { this.firstName = v; } }` });
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        const foo = classOf(r, "Foo");
        assert.equal(foo.fields.find((f) => f.name === "name"), undefined);
        assert.ok((foo.methods ?? []).some((m) => m.name === "name" && m.kind === "getter"));
        assert.ok((foo.methods ?? []).some((m) => m.name === "name" && m.kind === "setter"));
    });
});

describe("initializer defaults", () => {
    it("lowers a literal property-initializer default", () => {
        const r = cv({ "s.ts": `class Foo { status: string = "active"; }` });
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        assert.deepEqual(classOf(r, "Foo").fields.find((f) => f.name === "status")?.default, { kind: "literal", value: "active" });
    });

    it("lowers an enum-member initializer to a literal default", () => {
        const r = cv({ "s.ts": `enum Role { Member = "member", Admin = "admin" } class Foo { role: Role = Role.Member; }` });
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        assert.deepEqual(classOf(r, "Foo").fields.find((f) => f.name === "role")?.default, { kind: "literal", value: "member" });
    });

    it("lowers a non-literal initializer to an expression default", () => {
        const r = cv({ "s.ts": `class Foo { createdOn: Date = (() => new Date())(); }` });
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        assert.equal(classOf(r, "Foo").fields.find((f) => f.name === "createdOn")?.default?.kind, "expression");
    });

    it("rejects a type-incompatible literal default (KEYMA090)", () => {
        // The frontend extracts the literal from the AST and compares against the field type,
        // independent of TS's own assignability check, so a literal/field-type mismatch surfaces.
        assert.ok(hasError(cv({ "s.ts": `class Foo { status: string = 5; }` }), KEYMA090));
    });
});

describe("named enums", () => {
    it("records a portable named TS enum in ir.enums and maps the field type", () => {
        const r = cv({ "s.ts": `enum Status { Active = "active", Archived = "archived" } class Foo { declare status: Status; }` });
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        assert.deepEqual(classOf(r, "Foo").fields.find((f) => f.name === "status")?.type, { kind: "enum", name: "Status", values: ["active", "archived"] });
        assert.equal(r.ir.enums?.[0]?.name, "Status");
        assert.deepEqual(r.ir.enums?.[0]?.members, [
            { name: "Active", value: "active" },
            { name: "Archived", value: "archived" },
        ]);
    });
});

describe("IR document envelope", () => {
    it("carries irVersion + compilerVersion and mirrors diagnostics", () => {
        const r = cv({ "s.ts": `class T { declare x: string; }` });
        assert.equal(typeof r.ir.irVersion, "string");
        assert.equal(typeof r.ir.compilerVersion, "string");
        assert.deepEqual(r.ir.diagnostics, r.diagnostics);
    });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRClassDeclaration, IRFunctionDeclaration, IRMethod, IRStatement, IRExpression } from "@keyma/core/ir";
import { checkStatement, checkExpression } from "@keyma/core/ir";
import { synthesizeClassMembers, type SynthesizeDeps } from "../../src/frontend-ts/synthesize.js";

const SRC = { file: "user.ts", line: 1, column: 1 };

// A factory decl whose only purpose here is to carry the OUTER param list (arg ordering) and the
// INNER arrow arity (how many args the synthesized call passes).
function decl(name: string, outerParams: string[], innerArity: number): IRFunctionDeclaration {
    return {
        name,
        params: outerParams.map((p) => ({ name: p, type: { kind: "json" } as const })),
        returnType: { kind: "function", params: [], returns: { kind: "json" } },
        statements: [{
            kind: "return",
            value: { kind: "arrow", params: Array.from({ length: innerArity }, (_, i) => `p${i}`), body: { kind: "literal", value: null } },
        }],
        source: SRC,
    };
}

const FNS = new Map<string, IRFunctionDeclaration>([
    ["required", decl("required", [], 1)],            // required()(value)
    ["minLength", decl("minLength", ["value"], 2)],   // minLength(2)(value, field)
    ["trim", decl("trim", [], 1)],                    // trim()(value)
    ["normalize", decl("normalize", [], 2)],          // normalize()(value, ctx)
]);

const USER: IRClassDeclaration = {
    name: "user", sourceName: "User", visibility: "public",
    fields: [
        { name: "id", type: { kind: "id" }, visibility: "public", readonly: true, required: true, extensions: { schema: { validators: [{ name: "required" }], indexes: [{ unique: true }] } }, source: SRC },
        { name: "firstName", type: { kind: "string" }, visibility: "public", readonly: false, required: true, extensions: { schema: { validators: [{ name: "minLength", params: { value: 2 } }], formatters: [{ phase: "change", spec: { name: "trim" } }, { phase: "save", spec: { name: "normalize" } }] } }, source: SRC },
        { name: "role", type: { kind: "string" }, visibility: "public", readonly: false, required: true, default: { kind: "literal", value: "member" }, source: SRC },
        { name: "secret", type: { kind: "string" }, visibility: "private", readonly: false, required: false, extensions: { schema: { validators: [{ name: "required" }] } }, source: SRC },
    ],
    source: SRC,
};

const DEPS: SynthesizeDeps = { functionDecls: FNS, classesBySourceName: new Map([["User", USER]]) };

function byName(methods: IRMethod[], name: string): IRMethod | undefined {
    return methods.find((m) => m.name === name);
}

/** Every synthesized statement / expression must be valid-by-construction. */
function assertStatementsValid(stmts: IRStatement[], where: string): void {
    stmts.forEach((s, i) => assert.deepEqual(checkStatement(s, `${where}[${i}]`), [], `${where}[${i}] invalid`));
}
function assertExprValid(e: IRExpression, where: string): void {
    assert.deepEqual(checkExpression(e, where), [], `${where} invalid`);
}

describe("schema synthesis — validate()", () => {
    const { methods } = synthesizeClassMembers(USER, DEPS);
    const validate = byName(methods, "validate");

    it("emits a validate() method returning ValidationError[]", () => {
        assert.ok(validate !== undefined, "validate missing");
        assert.deepEqual(validate!.returnType, { kind: "array", of: { kind: "external", name: "ValidationError" } });
        assert.equal(validate!.visibility, "public");
    });

    it("builds the {object: self} ctx and filters non-null checks", () => {
        const stmts = validate!.statements;
        assert.equal(stmts[0]!.kind, "const");
        assert.deepEqual((stmts[0] as { init: unknown }).init, { kind: "object", properties: [{ key: "object", value: { kind: "intrinsic", op: "self", receiver: null, args: [] } }] });
        const r = stmts[1] as { kind: string; value: IRExpression };
        assert.equal(r.kind, "return");
        assert.equal(r.value.kind, "intrinsic");
        assert.equal((r.value as { op: string }).op, "array.filter");
    });

    it("calls each factory then invokes it with (value, field, ctx) truncated to inner arity", () => {
        // The full (server) body validates id (required), firstName (minLength), secret (required).
        const filter = (validate!.statements[1] as { value: { receiver: { elements: IRExpression[] } } }).value;
        const checks = filter.receiver.elements;
        assert.equal(checks.length, 3, "id + firstName + secret");
        // required()(this.id)  — inner arity 1 → only the value arg
        assert.deepEqual(checks[0], {
            kind: "call",
            callee: { kind: "call", callee: { kind: "identifier", name: "required" }, args: [] },
            args: [{ kind: "field", name: "id" }],
        });
        // minLength(2)(this.firstName, "firstName")  — inner arity 2 → value + field
        assert.deepEqual(checks[1], {
            kind: "call",
            callee: { kind: "call", callee: { kind: "identifier", name: "minLength" }, args: [{ kind: "literal", value: 2 }] },
            args: [{ kind: "field", name: "firstName" }, { kind: "literal", value: "firstName" }],
        });
    });

    it("gates the private field's check to server/library (client body omits secret)", () => {
        assert.ok(validate!.bodyAudience !== undefined, "expected bodyAudience for private-field gating");
        assert.deepEqual(validate!.bodyAudience!.audiences, ["server", "library"]);
        const clientChecks = (validate!.bodyAudience!.fallback[1] as { value: { receiver: { elements: IRExpression[] } } }).value.receiver.elements;
        assert.equal(clientChecks.length, 2, "client validates only public id + firstName");
    });

    it("is valid-by-construction", () => {
        assertStatementsValid(validate!.statements, "validate");
        assertStatementsValid(validate!.bodyAudience!.fallback, "validate.fallback");
    });
});

describe("schema synthesis — format phases", () => {
    const { methods } = synthesizeClassMembers(USER, DEPS);

    it("emits formatChange (change-phase formatter present) and applies it in place", () => {
        const fc = byName(methods, "formatChange");
        assert.ok(fc !== undefined, "formatChange missing");
        // const ctx = {object: self}; this.firstName = trim()(this.firstName);
        const assignStmt = fc!.statements[1] as { kind: string; target: unknown; value: IRExpression };
        assert.equal(assignStmt.kind, "assign");
        assert.deepEqual(assignStmt.target, { kind: "field", name: "firstName" });
        assert.deepEqual(assignStmt.value, {
            kind: "call",
            callee: { kind: "call", callee: { kind: "identifier", name: "trim" }, args: [] },
            args: [{ kind: "field", name: "firstName" }],
        });
        assertStatementsValid(fc!.statements, "formatChange");
    });

    it("emits formatSave gated server/library-only with an identity (empty) client fallback", () => {
        const fs = byName(methods, "formatSave");
        assert.ok(fs !== undefined, "formatSave missing");
        assert.ok(fs!.bodyAudience !== undefined, "formatSave must be audience-gated");
        assert.deepEqual(fs!.bodyAudience!.audiences, ["server", "library"]);
        assert.deepEqual(fs!.bodyAudience!.fallback, [], "client fallback is the identity no-op");
        // normalize has inner arity 2 → passes (value, ctx)
        const assignStmt = fs!.statements[1] as { value: { args: IRExpression[] } };
        assert.deepEqual(assignStmt.value.args, [{ kind: "field", name: "firstName" }, { kind: "identifier", name: "ctx" }]);
    });

    it("does not emit formatBlur/formatSubmit (no formatters in those phases)", () => {
        assert.equal(byName(methods, "formatBlur"), undefined);
        assert.equal(byName(methods, "formatSubmit"), undefined);
    });
});

describe("schema synthesis — applyDefaults()", () => {
    const { methods } = synthesizeClassMembers(USER, DEPS);
    it("nullish-coalesces each defaulted field's value", () => {
        const ad = byName(methods, "applyDefaults");
        assert.ok(ad !== undefined, "applyDefaults missing");
        assert.deepEqual(ad!.statements, [
            { kind: "assign", target: { kind: "field", name: "role" }, value: { kind: "binary", op: "??", left: { kind: "field", name: "role" }, right: { kind: "literal", value: "member" } } },
        ]);
        assertStatementsValid(ad!.statements, "applyDefaults");
    });
});

describe("schema synthesis — metadata static", () => {
    const { statics } = synthesizeClassMembers(USER, DEPS);
    const meta = statics.find((s) => s.name === "metadata");

    it("emits a metadata static gated to drop private fields + indexes on the client", () => {
        assert.ok(meta !== undefined, "metadata static missing");
        assert.ok(meta!.audience !== undefined, "private field + indexes ⇒ client-reduced fallback");
        assert.deepEqual(meta!.audience!.audiences, ["server", "library"]);
    });

    it("full value carries name/sourceName + all fields; client value drops the private field", () => {
        const full = meta!.value as { properties: { key: string; value: IRExpression }[] };
        const fields = full.properties.find((p) => p.key === "fields")!.value as { elements: IRExpression[] };
        assert.equal(fields.elements.length, 4, "server metadata lists all 4 fields");
        const client = meta!.audience!.fallback as { properties: { key: string; value: IRExpression }[] };
        const clientFields = client.properties.find((p) => p.key === "fields")!.value as { elements: IRExpression[] };
        assert.equal(clientFields.elements.length, 3, "client metadata omits the private field");
        // Client metadata also drops indexes.
        assert.equal(client.properties.some((p) => p.key === "indexes"), false, "client metadata omits indexes");
    });

    it("carries no live validators/formatters (pure json introspection)", () => {
        assertExprValid(meta!.value, "metadata.value");
        assertExprValid(meta!.audience!.fallback, "metadata.fallback");
        // No nested `call`/`arrow` (live functions) anywhere in the metadata expression.
        const json = JSON.stringify(meta!.value);
        assert.equal(/"kind":"(call|arrow)"/.test(json), false, "metadata must be pure data, no live functions");
    });
});

describe("schema synthesis — no-op classes", () => {
    it("omits validate/format/applyDefaults when a class has none, but always emits metadata", () => {
        const plain: IRClassDeclaration = {
            name: "tag", sourceName: "Tag", visibility: "public",
            fields: [{ name: "label", type: { kind: "string" }, visibility: "public", readonly: false, required: true, source: SRC }],
            source: SRC,
        };
        const { methods, statics } = synthesizeClassMembers(plain, { functionDecls: new Map(), classesBySourceName: new Map([["Tag", plain]]) });
        assert.equal(methods.length, 0, "no validators/formatters/defaults ⇒ no methods");
        assert.equal(statics.length, 1);
        assert.equal(statics[0]!.name, "metadata");
        assert.equal(statics[0]!.audience, undefined, "no private fields/indexes ⇒ no client gating");
    });
});

describe("schema synthesis — inheritance (flatten)", () => {
    const PERSON: IRClassDeclaration = {
        name: "person", sourceName: "Person", visibility: "public",
        fields: [{ name: "name", type: { kind: "string" }, visibility: "public", readonly: false, required: true, extensions: { schema: { validators: [{ name: "required" }] } }, source: SRC }],
        source: SRC,
    };
    const EMPLOYEE: IRClassDeclaration = {
        name: "employee", sourceName: "Employee", visibility: "public", extends: "Person",
        fields: [{ name: "dept", type: { kind: "string" }, visibility: "public", readonly: false, required: true, extensions: { schema: { validators: [{ name: "required" }] } }, source: SRC }],
        source: SRC,
    };
    const deps: SynthesizeDeps = { functionDecls: FNS, classesBySourceName: new Map([["Person", PERSON], ["Employee", EMPLOYEE]]) };

    it("validate() flattens inherited fields' checks (own + inherited), no super call", () => {
        const { methods } = synthesizeClassMembers(EMPLOYEE, deps);
        const validate = byName(methods, "validate")!;
        const checks = (validate.statements[1] as { value: { receiver: { elements: IRExpression[] } } }).value.receiver.elements;
        assert.equal(checks.length, 2, "validates inherited name + own dept");
        const json = JSON.stringify(validate.statements);
        assert.equal(/"name":"super"|"kind":"super"/.test(json), false, "no super construct");
    });

    it("metadata carries OWN fields only with base → Parent.metadata", () => {
        const { statics } = synthesizeClassMembers(EMPLOYEE, deps);
        const full = statics[0]!.value as { properties: { key: string; value: IRExpression }[] };
        const fields = full.properties.find((p) => p.key === "fields")!.value as { elements: IRExpression[] };
        assert.equal(fields.elements.length, 1, "OWN fields only (dept)");
        assert.deepEqual(full.properties.find((p) => p.key === "base")!.value, { kind: "member", object: { kind: "identifier", name: "Person" }, member: "metadata" });
    });
});

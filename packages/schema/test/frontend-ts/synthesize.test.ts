import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRClassDeclaration, IRFunctionDeclaration, IRMethod, IRStatement, IRExpression } from "@keyma/core/ir";
import { checkStatement, defaultIntrinsics } from "@keyma/core/ir";
import { synthesizeClassMembers, type SynthesizeDeps } from "../../src/frontend-ts/synthesize.js";
import { errorCollectIntrinsic } from "../../src/runtime-contract.js";

// Synthesis emits the schema-domain `error.collect` op; register it onto the default registry
// (exactly as `prepareDomains` does for the CLI) so `checkExpression` accepts the synthesized body.
defaultIntrinsics.register(errorCollectIntrinsic);

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

describe("schema synthesis — validate()", () => {
    const { methods } = synthesizeClassMembers(USER, DEPS);
    const validate = byName(methods, "validate");

    it("emits a validate() method returning ValidationError[]", () => {
        assert.ok(validate !== undefined, "validate missing");
        assert.deepEqual(validate!.returnType, { kind: "array", of: { kind: "external", name: "ValidationError" } });
        assert.equal(validate!.visibility, "public");
    });

    it("builds the ValidatorCtx{object: self} ctx and collects non-null checks", () => {
        const stmts = validate!.statements;
        assert.equal(stmts[0]!.kind, "const");
        assert.deepEqual((stmts[0] as { init: unknown }).init, { kind: "record", type: { kind: "external", name: "ValidatorCtx" }, properties: [{ key: "object", value: { kind: "intrinsic", op: "self", receiver: null, args: [] } }] });
        const r = stmts[1] as { kind: string; value: IRExpression };
        assert.equal(r.kind, "return");
        assert.equal(r.value.kind, "intrinsic");
        assert.equal((r.value as { op: string }).op, "error.collect");
    });

    it("calls each factory then invokes it with the uniform (value, field, ctx)", () => {
        // The full (server) body validates id (required), firstName (minLength), secret (required).
        const checks = (validate!.statements[1] as { value: { args: IRExpression[] } }).value.args;
        assert.equal(checks.length, 3, "id + firstName + secret");
        // required()(this.id, "id", ctx)
        assert.deepEqual(checks[0], {
            kind: "call",
            callee: { kind: "call", callee: { kind: "identifier", name: "required" }, args: [] },
            args: [{ kind: "field", name: "id" }, { kind: "literal", value: "id" }, { kind: "identifier", name: "ctx" }],
        });
        // minLength(2)(this.firstName, "firstName", ctx)
        assert.deepEqual(checks[1], {
            kind: "call",
            callee: { kind: "call", callee: { kind: "identifier", name: "minLength" }, args: [{ kind: "literal", value: 2 }] },
            args: [{ kind: "field", name: "firstName" }, { kind: "literal", value: "firstName" }, { kind: "identifier", name: "ctx" }],
        });
    });

    it("gates the private field's check to server/library (client body omits secret)", () => {
        assert.ok(validate!.bodyAudience !== undefined, "expected bodyAudience for private-field gating");
        assert.deepEqual(validate!.bodyAudience!.audiences, ["server", "library"]);
        const clientChecks = (validate!.bodyAudience!.fallback[1] as { value: { args: IRExpression[] } }).value.args;
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
            args: [{ kind: "field", name: "firstName" }, { kind: "identifier", name: "ctx" }],
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
    it("does NOT synthesize an applyDefaults() method (defaults apply at construction)", () => {
        assert.equal(byName(methods, "applyDefaults"), undefined);
    });
});

describe("schema synthesis — no-op classes", () => {
    it("omits validate/format when a class has none", () => {
        const plain: IRClassDeclaration = {
            name: "tag", sourceName: "Tag", visibility: "public",
            fields: [{ name: "label", type: { kind: "string" }, visibility: "public", readonly: false, required: true, source: SRC }],
            source: SRC,
        };
        const { methods } = synthesizeClassMembers(plain, { functionDecls: new Map(), classesBySourceName: new Map([["Tag", plain]]) });
        assert.equal(methods.length, 0, "no validators/formatters ⇒ no methods");
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
        const checks = (validate.statements[1] as { value: { args: IRExpression[] } }).value.args;
        assert.equal(checks.length, 2, "validates inherited name + own dept");
        const json = JSON.stringify(validate.statements);
        assert.equal(/"name":"super"|"kind":"super"/.test(json), false, "no super construct");
    });
});

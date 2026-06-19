import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual } from "../src/compile.js";
import type { IRExpression, IRStatement } from "@keyma/ir";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIRTUAL_BASE = path.join(__dirname, "..", "..", "src");

function cv(sources: Record<string, string>) {
    return compileVirtual(sources, { baseDir: VIRTUAL_BASE });
}
function errorCodes(r: ReturnType<typeof cv>): string[] {
    return r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}
function validatorBody(r: ReturnType<typeof cv>, name: string): IRStatement[] {
    const d = r.ir.validatorDeclarations?.find((v) => v.name === name);
    assert.ok(d, `validator "${name}" not found`);
    return d.body.statements;
}
/** The expression returned by a single-`return` validator body. */
function returnedExpr(stmts: IRStatement[]): IRExpression {
    const ret = stmts.find((s) => s.kind === "return");
    assert.ok(ret && ret.kind === "return" && ret.value, "expected a return with a value");
    return ret.value;
}

describe("intrinsic recognition", () => {
    it("lowers string methods and members to intrinsics, with input type", () => {
        const r = cv({
            "v.ts": `
                import { Validator } from "@keyma/dsl";
                export const v = Validator("v", () => (value: string) =>
                    value.includes("x") && value.length > 3 ? null : "bad");
            `,
        });
        assert.deepEqual(errorCodes(r), []);
        const d = r.ir.validatorDeclarations?.find((x) => x.name === "v");
        assert.deepEqual(d?.inputType, { kind: "string" });
        const expr = returnedExpr(validatorBody(r, "v"));
        // conditional → condition is `includes && length>3`
        assert.equal(expr.kind, "conditional");
        const cond = expr.kind === "conditional" ? expr.condition : undefined;
        assert.ok(cond && cond.kind === "binary" && cond.op === "&&");
        const left = cond.kind === "binary" ? cond.left : undefined;
        assert.deepEqual(left, {
            kind: "intrinsic", op: "string.includes",
            receiver: { kind: "identifier", name: "value" },
            args: [{ kind: "literal", value: "x" }],
        });
    });

    it("lowers `typeof x === \"string\"` to a type-is intrinsic", () => {
        const r = cv({
            "v.ts": `
                import { Validator } from "@keyma/dsl";
                export const v = Validator("v", () => (value: string) =>
                    typeof value === "string" ? null : "x");
            `,
        });
        assert.deepEqual(errorCodes(r), []);
        const expr = returnedExpr(validatorBody(r, "v"));
        const cond = expr.kind === "conditional" ? expr.condition : undefined;
        assert.deepEqual(cond, {
            kind: "intrinsic", op: "type-is",
            receiver: { kind: "identifier", name: "value" },
            args: [{ kind: "literal", value: "string" }],
        });
    });

    it("lowers `x instanceof Date` to an instance-of intrinsic", () => {
        const r = cv({
            "v.ts": `
                import { Validator } from "@keyma/dsl";
                export const v = Validator("v", () => (value: string) =>
                    value instanceof Date ? "x" : null);
            `,
        });
        assert.deepEqual(errorCodes(r), []);
        const expr = returnedExpr(validatorBody(r, "v"));
        const cond = expr.kind === "conditional" ? expr.condition : undefined;
        assert.ok(cond && cond.kind === "intrinsic" && cond.op === "instance-of");
        assert.deepEqual(cond.kind === "intrinsic" ? cond.args : [], [{ kind: "literal", value: "Date" }]);
    });
});

describe("typed validator/formatter inputs", () => {
    it("KEYMA084 — rejects an untyped (implicit unknown) value param", () => {
        const r = cv({
            "v.ts": `
                import { Validator } from "@keyma/dsl";
                export const v = Validator("v", () => (value) => value === null ? "x" : null);
            `,
        });
        assert.ok(errorCodes(r).includes("KEYMA084"), JSON.stringify(r.diagnostics));
    });

    it("KEYMA084 — rejects an explicit `unknown` value param", () => {
        const r = cv({
            "v.ts": `
                import { Validator } from "@keyma/dsl";
                export const v = Validator("v", () => (value: unknown) => null);
            `,
        });
        assert.ok(errorCodes(r).includes("KEYMA084"));
    });

    it("allows the DSL `Json` type as a polymorphic input (no error)", () => {
        const r = cv({
            "v.ts": `
                import { Validator } from "@keyma/dsl";
                import type { Json } from "@keyma/dsl";
                export const v = Validator("v", () => (value: Json) => value === null ? "x" : null);
            `,
        });
        assert.deepEqual(errorCodes(r), []);
        const d = r.ir.validatorDeclarations?.find((x) => x.name === "v");
        assert.deepEqual(d?.inputType, { kind: "json" });
    });
});

describe("unsupported intrinsics & instanceof", () => {
    it("KEYMA085 — rejects an unsupported string method", () => {
        const r = cv({
            "v.ts": `
                import { Validator } from "@keyma/dsl";
                export const v = Validator("v", () => (value: string) =>
                    value.padStart(3, "0") === value ? null : "x");
            `,
        });
        assert.ok(errorCodes(r).includes("KEYMA085"), JSON.stringify(r.diagnostics));
    });

    it("KEYMA087 — rejects a non-portable instanceof constructor", () => {
        const r = cv({
            "v.ts": `
                import { Validator } from "@keyma/dsl";
                class Foo {}
                export const v = Validator("v", () => (value: string) =>
                    (value as unknown) instanceof Foo ? "x" : null);
            `,
        });
        assert.ok(errorCodes(r).includes("KEYMA087"), JSON.stringify(r.diagnostics));
    });
});

describe("utility-function compilation", () => {
    it("compiles a project-local function called from a validator body (transitively)", () => {
        const r = cv({
            "v.ts": `
                import { Validator } from "@keyma/dsl";
                function longEnough(s: string): boolean { return atLeast(s, 3); }
                function atLeast(s: string, n: number): boolean { return s.length >= n; }
                export const v = Validator("v", () => (value: string) =>
                    longEnough(value) ? null : "x");
            `,
        });
        assert.deepEqual(errorCodes(r), []);
        const names = (r.ir.functionDeclarations ?? []).map((f) => f.name).sort();
        assert.deepEqual(names, ["atLeast", "longEnough"], "both functions compiled transitively");
        const longEnough = r.ir.functionDeclarations?.find((f) => f.name === "longEnough");
        assert.deepEqual(longEnough?.params, [{ name: "s", type: { kind: "string" } }]);
        assert.deepEqual(longEnough?.returnType, { kind: "boolean" });
    });

    it("KEYMA086 — rejects a call to a non-project-local (declared) function", () => {
        const r = cv({
            "ext.d.ts": `export declare function ext(s: string): boolean;`,
            "v.ts": `
                import { Validator } from "@keyma/dsl";
                import { ext } from "./ext.js";
                export const v = Validator("v", () => (value: string) =>
                    ext(value) ? null : "x");
            `,
        });
        assert.ok(errorCodes(r).includes("KEYMA086"), JSON.stringify(r.diagnostics));
    });
});

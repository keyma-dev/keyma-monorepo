import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual } from "./harness.js";
import type { IRExpression, IRStatement } from "@keyma/core/ir";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIRTUAL_BASE = path.join(__dirname, "..", "..", "..", "src", "frontend-ts");

function cv(sources: Record<string, string>) {
    return compileVirtual(sources, { baseDir: VIRTUAL_BASE });
}
function errorCodes(r: ReturnType<typeof cv>): string[] {
    return r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

/**
 * Compile a validator `v` (factory returning `ValidatorFn<valueType>`) that is
 * referenced by a schema field, so the use-driven collector lowers its body.
 * `decls` injects extra top-level declarations (helper functions, classes).
 */
function cvValidator(ret: string, valueType = "string", decls = "") {
    return cv({
        "v.ts": `
            import { Schema, Validate } from "@keyma/schema/dsl";
            import type { ValidatorFn, Json } from "@keyma/schema/dsl";
            ${decls}
            export function v(): ValidatorFn<${valueType}> { return (value) => ${ret}; }
            @Schema() class Holder { @Validate(v()) declare a: string; }
        `,
    });
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
        const r = cvValidator(`value.includes("x") && value.length > 3 ? null : "bad"`);
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
        const r = cvValidator(`typeof value === "string" ? null : "x"`);
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
        const r = cvValidator(`value instanceof Date ? "x" : null`);
        assert.deepEqual(errorCodes(r), []);
        const expr = returnedExpr(validatorBody(r, "v"));
        const cond = expr.kind === "conditional" ? expr.condition : undefined;
        assert.ok(cond && cond.kind === "intrinsic" && cond.op === "instance-of");
        assert.deepEqual(cond.kind === "intrinsic" ? cond.args : [], [{ kind: "literal", value: "Date" }]);
    });

    it("lowers a Date accessor method on a Date-typed value to a date intrinsic", () => {
        const r = cvValidator(`value.getTime() > 0 ? null : "x"`, "Date");
        assert.deepEqual(errorCodes(r), []);
        const expr = returnedExpr(validatorBody(r, "v"));
        const cond = expr.kind === "conditional" ? expr.condition : undefined;
        const left = cond && cond.kind === "binary" ? cond.left : undefined;
        assert.deepEqual(left, {
            kind: "intrinsic", op: "date.getTime",
            receiver: { kind: "identifier", name: "value" }, args: [],
        });
    });

    it("KEYMA085 — rejects an unsupported Date method on a Date-typed value", () => {
        const r = cvValidator(`value.setHours(0) > 0 ? null : "x"`, "Date");
        assert.ok(errorCodes(r).includes("KEYMA085"), JSON.stringify(r.diagnostics));
    });
});

describe("validator/formatter input type (from ValidatorFn<T>)", () => {
    it("maps the `ValidatorFn<T>` argument to the input guard type", () => {
        const r = cvValidator(`value.length > 0 ? null : "x"`, "string");
        assert.deepEqual(errorCodes(r), []);
        const d = r.ir.validatorDeclarations?.find((x) => x.name === "v");
        assert.deepEqual(d?.inputType, { kind: "string" });
    });

    it("a bare `ValidatorFn` (no type argument) yields an unguarded `json` input", () => {
        const r = cvValidator(`value === null ? "x" : null`, "");
        assert.deepEqual(errorCodes(r), []);
        const d = r.ir.validatorDeclarations?.find((x) => x.name === "v");
        assert.deepEqual(d?.inputType, { kind: "json" });
    });

    it("`ValidatorFn<unknown>` yields a `json` input (no guard)", () => {
        const r = cvValidator(`value === null ? "x" : null`, "unknown");
        assert.deepEqual(errorCodes(r), []);
        const d = r.ir.validatorDeclarations?.find((x) => x.name === "v");
        assert.deepEqual(d?.inputType, { kind: "json" });
    });

    it("allows the DSL `Json` type as a polymorphic input", () => {
        const r = cvValidator(`value === null ? "x" : null`, "Json");
        assert.deepEqual(errorCodes(r), []);
        const d = r.ir.validatorDeclarations?.find((x) => x.name === "v");
        assert.deepEqual(d?.inputType, { kind: "json" });
    });
});

describe("unsupported intrinsics & instanceof", () => {
    it("KEYMA085 — rejects an unsupported string method", () => {
        const r = cvValidator(`value.padStart(3, "0") === value ? null : "x"`);
        assert.ok(errorCodes(r).includes("KEYMA085"), JSON.stringify(r.diagnostics));
    });

    it("KEYMA087 — rejects a non-portable instanceof constructor", () => {
        const r = cvValidator(`(value as unknown) instanceof Foo ? "x" : null`, "string", "class Foo {}");
        assert.ok(errorCodes(r).includes("KEYMA087"), JSON.stringify(r.diagnostics));
    });
});

describe("utility-function compilation", () => {
    it("compiles a project-local function called from a validator body (transitively)", () => {
        const r = cvValidator(
            `longEnough(value) ? null : "x"`,
            "string",
            `function longEnough(s: string): boolean { return atLeast(s, 3); }
             function atLeast(s: string, n: number): boolean { return s.length >= n; }`,
        );
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
                import { Schema, Validate } from "@keyma/schema/dsl";
                import type { ValidatorFn } from "@keyma/schema/dsl";
                import { ext } from "./ext.js";
                export function v(): ValidatorFn<string> { return (value) => ext(value) ? null : "x"; }
                @Schema() class Holder { @Validate(v()) declare a: string; }
            `,
        });
        assert.ok(errorCodes(r).includes("KEYMA086"), JSON.stringify(r.diagnostics));
    });
});

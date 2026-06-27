import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRDiagnostic, IRExpression, IRFunctionDeclaration } from "@keyma/core/ir";
import { createFunctionCollector, KEYMA085, KEYMA086, KEYMA087 } from "../../src/frontend-ts/index.js";
import { build } from "./_helpers.js";

// Intrinsic recognition is part of the shared portable engine and applies to any project-local
// utility-function body — exercised here through `createFunctionCollector` on plain functions, with
// no `@Validate`/`ValidatorFn` in the loop. (The `ValidatorFn<T>` → input-guard typing is schema's.)

function collect(src: string): { fns: IRFunctionDeclaration[]; diags: IRDiagnostic[] } {
    const b = build(src);
    const diags: IRDiagnostic[] = [];
    const collector = createFunctionCollector({
        checker: b.checker,
        dslModuleName: "@keyma/schema/dsl",
        classNames: new Set<string>(),
        diagnostics: diags,
    });
    collector.enqueueLocalSurface(b.program, () => false);
    const fns = collector.drain();
    return { fns, diags };
}

const errorCodes = (diags: IRDiagnostic[]) => diags.filter((d) => d.severity === "error").map((d) => d.code);

/** Collect `function v(...) { return <expr>; }` and return its lowered return expression. */
function returnedExpr(src: string): IRExpression {
    const { fns, diags } = collect(src);
    assert.deepEqual(errorCodes(diags), [], JSON.stringify(diags));
    const v = fns.find((f) => f.name === "v");
    assert.ok(v, "function v not found");
    const ret = v!.statements.find((s) => s.kind === "return");
    assert.ok(ret && ret.kind === "return" && ret.value, "expected a return with a value");
    return ret.value;
}

function vFn(src: string): IRFunctionDeclaration | undefined {
    return collect(src).fns.find((f) => f.name === "v");
}

describe("intrinsic recognition", () => {
    it("lowers string methods and members to intrinsics, on the param receiver", () => {
        const expr = returnedExpr(`function v(value: string): string | null { return value.includes("x") && value.length > 3 ? null : "bad"; }`);
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
        const expr = returnedExpr(`function v(value: string): string | null { return typeof value === "string" ? null : "x"; }`);
        const cond = expr.kind === "conditional" ? expr.condition : undefined;
        assert.deepEqual(cond, {
            kind: "intrinsic", op: "type-is",
            receiver: { kind: "identifier", name: "value" },
            args: [{ kind: "literal", value: "string" }],
        });
    });

    it("lowers `x instanceof Date` to an instance-of intrinsic", () => {
        const expr = returnedExpr(`function v(value: string): string | null { return value instanceof Date ? "x" : null; }`);
        const cond = expr.kind === "conditional" ? expr.condition : undefined;
        assert.ok(cond && cond.kind === "intrinsic" && cond.op === "instance-of");
        assert.deepEqual(cond.kind === "intrinsic" ? cond.args : [], [{ kind: "literal", value: "Date" }]);
    });

    it("lowers a Date accessor method on a Date-typed value to a date intrinsic", () => {
        const expr = returnedExpr(`function v(value: Date): string | null { return value.getTime() > 0 ? null : "x"; }`);
        const cond = expr.kind === "conditional" ? expr.condition : undefined;
        const left = cond && cond.kind === "binary" ? cond.left : undefined;
        assert.deepEqual(left, {
            kind: "intrinsic", op: "date.getTime",
            receiver: { kind: "identifier", name: "value" }, args: [],
        });
    });

    it("KEYMA085 — rejects an unsupported Date method on a Date-typed value", () => {
        assert.ok(errorCodes(collect(`function v(value: Date): string | null { return value.setHours(0) > 0 ? null : "x"; }`).diags).includes(KEYMA085));
    });
});

describe("unsupported intrinsics & instanceof", () => {
    it("KEYMA085 — rejects an unsupported string method", () => {
        assert.ok(errorCodes(collect(`function v(value: string): string | null { return value.padStart(3, "0") === value ? null : "x"; }`).diags).includes(KEYMA085));
    });

    it("KEYMA087 — rejects a non-portable instanceof constructor", () => {
        assert.ok(errorCodes(collect(`class Foo {} function v(value: string): string | null { return (value as unknown) instanceof Foo ? "x" : null; }`).diags).includes(KEYMA087));
    });
});

describe("utility-function compilation", () => {
    it("compiles a project-local function reached transitively from another body", () => {
        const { fns, diags } = collect(`
            function v(value: string): boolean { return longEnough(value); }
            function longEnough(s: string): boolean { return atLeast(s, 3); }
            function atLeast(s: string, n: number): boolean { return s.length >= n; }
        `);
        assert.deepEqual(errorCodes(diags), [], JSON.stringify(diags));
        const names = fns.map((f) => f.name).sort();
        assert.deepEqual(names, ["atLeast", "longEnough", "v"]);
        const longEnough = fns.find((f) => f.name === "longEnough");
        assert.deepEqual(longEnough?.params, [{ name: "s", type: { kind: "string" } }]);
        assert.deepEqual(longEnough?.returnType, { kind: "boolean" });
    });

    it("KEYMA086 — rejects a call to a non-project-local (ambient) function", () => {
        assert.ok(errorCodes(collect(`
            declare function ext(s: string): boolean;
            function v(value: string): string | null { return ext(value) ? null : "x"; }
        `).diags).includes(KEYMA086));
    });

    it("infers nothing odd for a plain boolean utility (sanity)", () => {
        const v = vFn(`function v(s: string): boolean { return s.length > 0; }`);
        assert.deepEqual(v?.returnType, { kind: "boolean" });
    });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual } from "./harness.js";
import type { IRExpression, IRType, IRFunctionDeclaration } from "@keyma/core/ir";

// Generic intrinsic recognition (string/date intrinsics, type-is, instance-of, unsupported-method
// rejection, transitive utility-function compilation) is domain-neutral and now lives in
// @keyma/compiler's frontend-ts/intrinsics.test.ts. What remains here is schema-specific: the
// `ValidatorFn<T>` factory argument mapping to the validator's input-guard type.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIRTUAL_BASE = path.join(__dirname, "..", "..", "..", "src", "frontend-ts");

function cv(sources: Record<string, string>) {
    return compileVirtual(sources, { baseDir: VIRTUAL_BASE });
}
function errorCodes(r: ReturnType<typeof cv>): string[] {
    return r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

/**
 * Compile a validator `v` (factory returning `ValidatorFn<valueType>`) referenced by a schema
 * field, so the use-driven collector lowers its body.
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

/** The inner arrow a validator/formatter factory `return`s (the collapsed-function shape). */
function innerArrow(d: IRFunctionDeclaration | undefined): Extract<IRExpression, { kind: "arrow" }> {
    const ret = d?.statements[0];
    assert.ok(
        ret && ret.kind === "return" && ret.value && ret.value.kind === "arrow",
        "validator factory must return an inner arrow",
    );
    return ret.value;
}
/** The input type a validator carries — the inner arrow's first param `.type`. */
function inputTypeOf(d: IRFunctionDeclaration | undefined): IRType | undefined {
    const p = innerArrow(d).params[0];
    return p === undefined || typeof p === "string" ? undefined : p.type;
}

describe("validator/formatter input type (from ValidatorFn<T>)", () => {
    it("maps the `ValidatorFn<T>` argument to the input guard type", () => {
        const r = cvValidator(`value.length > 0 ? null : "x"`, "string");
        assert.deepEqual(errorCodes(r), []);
        const d = r.ir.functionDeclarations?.find((x) => x.name === "v");
        assert.deepEqual(inputTypeOf(d), { kind: "string" });
    });

    it("a bare `ValidatorFn` (no type argument) yields an unguarded `json` input", () => {
        const r = cvValidator(`value === null ? "x" : null`, "");
        assert.deepEqual(errorCodes(r), []);
        const d = r.ir.functionDeclarations?.find((x) => x.name === "v");
        assert.deepEqual(inputTypeOf(d), { kind: "json" });
    });

    it("`ValidatorFn<unknown>` yields a `json` input (no guard)", () => {
        const r = cvValidator(`value === null ? "x" : null`, "unknown");
        assert.deepEqual(errorCodes(r), []);
        const d = r.ir.functionDeclarations?.find((x) => x.name === "v");
        assert.deepEqual(inputTypeOf(d), { kind: "json" });
    });

    it("allows the DSL `Json` type as a polymorphic input", () => {
        const r = cvValidator(`value === null ? "x" : null`, "Json");
        assert.deepEqual(errorCodes(r), []);
        const d = r.ir.functionDeclarations?.find((x) => x.name === "v");
        assert.deepEqual(inputTypeOf(d), { kind: "json" });
    });
});

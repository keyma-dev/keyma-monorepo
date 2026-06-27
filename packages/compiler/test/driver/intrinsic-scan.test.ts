import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KeymaIR, IRExpression } from "@keyma/core/ir";
import { defaultIntrinsics, type IntrinsicDef } from "@keyma/core/ir";
import { scanIntrinsicCompatibility } from "../../src/driver/index.js";
import { exprToJs } from "../../src/backend-js/emit-expression.js";
import { exprToPython } from "../../src/backend-python/emit-expression.js";
import { exprToCpp } from "../../src/backend-cpp/emit-expression.js";

// `node --test` isolates each test file in its own process, so registering test-scoped
// intrinsics onto the shared `defaultIntrinsics` here does not leak into other files.
const allLangs: IntrinsicDef = {
    op: "scan.test.allLangs", receiver: "value", form: "method", tsName: "", minArgs: 0, maxArgs: 0, tier: "recommended",
    emit: {
        js: (recv, args) => `allJs(${recv ?? ""}${args.join(", ")})`,
        python: (recv, args) => `all_py(${recv ?? ""}${args.join(", ")})`,
        cpp: (recv, args) => `keyma::all_cpp(${recv ?? ""}${args.join(", ")})`,
    },
};
const jsOnly: IntrinsicDef = {
    op: "scan.test.jsOnly", receiver: "value", form: "method", tsName: "", minArgs: 0, maxArgs: 0, tier: "recommended",
    emit: { js: (recv) => `jsOnly(${recv ?? ""})` },
};
defaultIntrinsics.register(allLangs);
defaultIntrinsics.register(jsOnly);

/** A minimal IR whose single utility function's body uses one intrinsic op. */
function irUsingOp(op: string): KeymaIR {
    return {
        irVersion: "10.0.0",
        compilerVersion: "0.1.0",
        classes: [],
        functionDeclarations: [{
            name: "f",
            params: [],
            returnType: { kind: "json" },
            statements: [{ kind: "return", value: { kind: "intrinsic", op, receiver: null, args: [] } }],
            source: { file: "x.ts", line: 1, column: 1 },
        }],
        diagnostics: [],
    };
}

const intrinsic = (op: string): IRExpression => ({ kind: "intrinsic", op, receiver: { kind: "identifier", name: "x" }, args: [] });

describe("driver pre-emit compatibility scan", () => {
    it("passes a built-in-only document for every target (no diagnostics)", () => {
        const diags = scanIntrinsicCompatibility(irUsingOp("string.length"), ["js", "python", "cpp"]);
        assert.deepEqual(diags, []);
    });

    it("passes a domain op that has an emitter for every configured target", () => {
        const diags = scanIntrinsicCompatibility(irUsingOp("scan.test.allLangs"), ["js", "python", "cpp"]);
        assert.deepEqual(diags, []);
    });

    it("fails a domain op missing an emitter for a configured target, naming (function, op, target)", () => {
        const diags = scanIntrinsicCompatibility(irUsingOp("scan.test.jsOnly"), ["js", "python"]);
        assert.equal(diags.length, 1, JSON.stringify(diags));
        const d = diags[0]!;
        assert.equal(d.severity, "error");
        assert.equal(d.code, "KEYMA0208");
        assert.match(d.message, /scan\.test\.jsOnly/);
        assert.match(d.message, /python/);
        assert.match(d.message, /function "f"/);
    });

    it("passes the same domain op when only its supported target is configured", () => {
        const diags = scanIntrinsicCompatibility(irUsingOp("scan.test.jsOnly"), ["js"]);
        assert.deepEqual(diags, []);
    });

    it("ignores unknown (non-backend) target languages — nothing to reason about", () => {
        const diags = scanIntrinsicCompatibility(irUsingOp("scan.test.jsOnly"), ["go"]);
        assert.deepEqual(diags, []);
    });

    it("scans class method bodies, not just utility functions", () => {
        const ir: KeymaIR = {
            irVersion: "10.0.0", compilerVersion: "0.1.0", diagnostics: [],
            classes: [{
                name: "thing", sourceName: "Thing", visibility: "public", fields: [],
                methods: [{
                    name: "check", kind: "method", params: [], returnType: { kind: "json" },
                    statements: [{ kind: "return", value: intrinsic("scan.test.jsOnly") }],
                    visibility: "public", source: { file: "x.ts", line: 1, column: 1 },
                }],
                source: { file: "x.ts", line: 1, column: 1 },
            }],
        };
        const diags = scanIntrinsicCompatibility(ir, ["python"]);
        assert.equal(diags.length, 1, JSON.stringify(diags));
        assert.match(diags[0]!.message, /method "Thing\.check"/);
    });
});

describe("registry-driven intrinsic emission (backend fallback)", () => {
    it("JS backend emits a domain op's native snippet via the registry", () => {
        assert.equal(exprToJs(intrinsic("scan.test.allLangs")), "allJs(x)");
    });

    it("Python backend emits a domain op's native snippet via the registry", () => {
        assert.equal(exprToPython(intrinsic("scan.test.allLangs")), "all_py(x)");
    });

    it("C++ backend emits a domain op's native snippet via the registry", () => {
        assert.equal(exprToCpp(intrinsic("scan.test.allLangs")), "keyma::all_cpp(x)");
    });

    it("falls back to the unsupported marker when the language has no registry emitter", () => {
        // `scan.test.jsOnly` has only a JS emitter — Python/C++ produce their unsupported markers.
        assert.match(exprToPython(intrinsic("scan.test.jsOnly")), /__keyma_unsupported_intrinsic__/);
        assert.match(exprToCpp(intrinsic("scan.test.jsOnly")), /unsupported_intrinsic/);
    });
});

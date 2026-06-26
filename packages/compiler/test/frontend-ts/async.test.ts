import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import type { IRDiagnostic } from "@keyma/core/ir";
import {
    lowerMethod,
    lowerExpr,
    createFunctionCollector,
    KEYMA082,
} from "../../src/frontend-ts/index.js";
import { build, methodCtx, portableCtx, findClass, classMethod, findFirst, hasCode } from "./_helpers.js";

describe("010 — async utility functions", () => {
    it("sets async=true and peels Promise<T> on the return type", () => {
        const b = build(`
            async function loadValue(): Promise<number> {
                return await Promise.resolve(5);
            }
        `);
        const diags: IRDiagnostic[] = [];
        const collector = createFunctionCollector({
            checker: b.checker,
            dslModuleName: "@keyma/schema/dsl",
            schemaClassNames: new Set<string>(),
            diagnostics: diags,
        });
        collector.enqueueLocalSurface(b.program, () => false);
        const fns = collector.drain();
        assert.equal(diags.length, 0, JSON.stringify(diags));
        const fn = fns.find((f) => f.name === "loadValue")!;
        assert.equal(fn.async, true);
        assert.deepEqual(fn.returnType, { kind: "number" });
        const ret = fn.statements[0]!;
        assert.equal(ret.kind, "return");
        if (ret.kind !== "return") return;
        assert.equal(ret.value?.kind, "await");
    });
});

describe("010 — async methods", () => {
    it("sets async=true, peels Promise<T>, and lowers await in the body", () => {
        const b = build(`
            class C {
                async load(): Promise<number> { return await Promise.resolve(5); }
            }
        `);
        const diags: IRDiagnostic[] = [];
        const method = lowerMethod(classMethod(findClass(b.sf, "C"), "load"), "load", "public", methodCtx(b, diags));
        assert.equal(diags.length, 0, JSON.stringify(diags));
        assert.ok(method);
        assert.equal(method!.async, true);
        assert.equal(method!.kind, "method");
        assert.deepEqual(method!.returnType, { kind: "number" });
        const ret = method!.statements[0]!;
        assert.equal(ret.kind, "return");
        if (ret.kind !== "return") return;
        assert.equal(ret.value?.kind, "await");
    });

    it("an async method returning Promise<void> yields no returnType", () => {
        const b = build(`
            class C { async run(): Promise<void> { await Promise.resolve(1); } }
        `);
        const diags: IRDiagnostic[] = [];
        const method = lowerMethod(classMethod(findClass(b.sf, "C"), "run"), "run", "public", methodCtx(b, diags));
        assert.equal(diags.length, 0, JSON.stringify(diags));
        assert.ok(method);
        assert.equal(method!.async, true);
        assert.equal("returnType" in method!, false);
    });

    it("a plain (sync) method has no async flag", () => {
        const b = build(`class C { plain(): number { return 1; } }`);
        const diags: IRDiagnostic[] = [];
        const method = lowerMethod(classMethod(findClass(b.sf, "C"), "plain"), "plain", "public", methodCtx(b, diags));
        assert.ok(method);
        assert.equal("async" in method!, false);
    });

    it("still rejects a generator method (KEYMA082)", () => {
        const b = build(`class C { *gen(): number { return 1; } }`);
        const diags: IRDiagnostic[] = [];
        const method = lowerMethod(classMethod(findClass(b.sf, "C"), "gen"), "gen", "public", methodCtx(b, diags));
        assert.equal(method, null);
        assert.ok(hasCode(diags, KEYMA082), JSON.stringify(diags));
    });
});

describe("010 — await expression", () => {
    it("lowers `await x` to { kind: 'await', operand }", () => {
        const b = build(`async function f(): Promise<number> { return await Promise.resolve(7); }`);
        const diags: IRDiagnostic[] = [];
        const awaitNode = findFirst(b.sf, ts.isAwaitExpression);
        const ir = lowerExpr(awaitNode, portableCtx(b, diags));
        assert.equal(diags.length, 0, JSON.stringify(diags));
        assert.ok(ir);
        assert.equal(ir!.kind, "await");
        if (ir!.kind !== "await") return;
        assert.equal(ir!.operand.kind, "call");
    });
});

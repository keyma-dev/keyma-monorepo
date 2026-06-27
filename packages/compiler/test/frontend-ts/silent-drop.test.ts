import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRDiagnostic } from "@keyma/core/ir";
import {
    lowerMethod,
    createFunctionCollector,
    KEYMA082,
} from "../../src/frontend-ts/index.js";
import { build, methodCtx, findClass, classMethod, hasCode } from "./_helpers.js";

// Decision 10: out-of-vocabulary in a function body is a hard error with NO partial emission.
// A body with one unlowerable statement must be discarded whole — never emitted partially —
// while still pushing its diagnostic (which halts the build).

describe("silent-statement-drop path is killed (decision 10)", () => {
    it("discards a whole method body when one statement is out-of-vocabulary", () => {
        // `throw` is not in the portable statement subset; the `const` before it lowers fine.
        const b = build(`class C { m(): number { const a = 1; throw new Error("x"); } }`);
        const diags: IRDiagnostic[] = [];
        const method = lowerMethod(classMethod(findClass(b.sf, "C"), "m"), "m", "public", methodCtx(b, diags));
        assert.ok(method, "method should still be produced (the diagnostic halts the build)");
        // No partial body: the successfully-lowered `const a = 1` is NOT emitted alongside the failure.
        assert.deepEqual(method!.statements, [], "partial body must be discarded, not emitted");
        assert.ok(hasCode(diags, KEYMA082), `expected KEYMA082, got ${JSON.stringify(diags)}`);
    });

    it("discards a whole utility-function body when one statement is out-of-vocabulary", () => {
        const b = build(`export function g(): number { const a = 1; throw new Error("x"); }`);
        const diags: IRDiagnostic[] = [];
        const collector = createFunctionCollector({
            checker: b.checker,
            dslModuleName: "@keyma/schema/dsl",
            classNames: new Set<string>(),
            diagnostics: diags,
        });
        collector.enqueueLocalSurface(b.program, () => false);
        const g = collector.drain().find((f) => f.name === "g")!;
        assert.deepEqual(g.statements, [], "partial body must be discarded, not emitted");
        assert.ok(hasCode(diags, KEYMA082), `expected KEYMA082, got ${JSON.stringify(diags)}`);
    });

    it("still lowers a fully-portable method body unchanged", () => {
        const b = build(`class C { m(): number { const a = 1; return a; } }`);
        const diags: IRDiagnostic[] = [];
        const method = lowerMethod(classMethod(findClass(b.sf, "C"), "m"), "m", "public", methodCtx(b, diags));
        assert.equal(diags.length, 0, JSON.stringify(diags));
        assert.equal(method!.statements.length, 2);
    });
});

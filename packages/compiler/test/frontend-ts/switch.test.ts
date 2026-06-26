import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRDiagnostic, IRStatement } from "@keyma/core/ir";
import { lowerStatements } from "../../src/frontend-ts/index.js";
import { build, portableCtx, findFunction } from "./_helpers.js";

function lowerFn(code: string, fnName = "f"): { stmts: IRStatement[]; diags: IRDiagnostic[] } {
    const b = build(code);
    const fn = findFunction(b.sf, fnName);
    const diags: IRDiagnostic[] = [];
    const stmts = lowerStatements(fn.body!.statements, portableCtx(b, diags));
    return { stmts, diags };
}

describe("012 — switch", () => {
    it("lowers cases + default, source-faithfully (fallthrough = empty body)", () => {
        const { stmts, diags } = lowerFn(`
            function f(n: number): string {
                switch (n) {
                    case 1:
                        return "one";
                    case 2:
                    case 3:
                        return "two-or-three";
                    default:
                        return "other";
                }
            }
        `);
        assert.equal(diags.length, 0, JSON.stringify(diags));
        const s = stmts[0]!;
        assert.equal(s.kind, "switch");
        if (s.kind !== "switch") return;
        assert.deepEqual(s.discriminant, { kind: "identifier", name: "n" });
        assert.equal(s.cases.length, 4);

        assert.deepEqual(s.cases[0]!.test, { kind: "literal", value: 1 });
        assert.equal(s.cases[0]!.body[0]!.kind, "return");

        // `case 2:` with no statements → empty body (fallthrough into case 3).
        assert.deepEqual(s.cases[1]!.test, { kind: "literal", value: 2 });
        assert.equal(s.cases[1]!.body.length, 0);

        assert.deepEqual(s.cases[2]!.test, { kind: "literal", value: 3 });
        assert.equal(s.cases[2]!.body[0]!.kind, "return");

        // default arm carries test=null.
        assert.equal(s.cases[3]!.test, null);
        assert.equal(s.cases[3]!.body[0]!.kind, "return");
    });

    it("lowers a trailing break inside a case to a break statement", () => {
        const { stmts, diags } = lowerFn(`
            function f(n: number): void {
                let r = "";
                switch (n) {
                    case 1:
                        r = "a";
                        break;
                    default:
                        r = "b";
                }
            }
        `);
        assert.equal(diags.length, 0, JSON.stringify(diags));
        const sw = stmts.find((x) => x.kind === "switch")!;
        assert.equal(sw.kind, "switch");
        if (sw.kind !== "switch") return;
        const case0 = sw.cases[0]!;
        assert.equal(case0.body.length, 2);
        assert.equal(case0.body[0]!.kind, "assign");
        assert.equal(case0.body[1]!.kind, "break");
    });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import type { IRDiagnostic, IRStatement } from "@keyma/core/ir";
import {
    lowerStatement,
    lowerStatements,
    KEYMA0201,
    KEYMA0202,
    KEYMA0203,
    KEYMA0204,
    KEYMA0205,
} from "../../src/frontend-ts/index.js";
import { build, portableCtx, findFunction, findFirst, hasCode } from "./_helpers.js";

/** Lower the body statement list of a top-level function. */
function lowerFn(code: string, fnName = "f"): { stmts: IRStatement[]; diags: IRDiagnostic[] } {
    const b = build(code);
    const fn = findFunction(b.sf, fnName);
    const diags: IRDiagnostic[] = [];
    const ctx = portableCtx(b, diags);
    const stmts = lowerStatements(fn.body!.statements, ctx);
    return { stmts, diags };
}

describe("011 — for…of", () => {
    it("lowers to a forOf with a simple const identifier binding", () => {
        const { stmts, diags } = lowerFn(`
            function f(items: number[]): void {
                for (const x of items) { const y = x; }
            }
        `);
        assert.equal(diags.length, 0, JSON.stringify(diags));
        assert.equal(stmts.length, 1);
        const s = stmts[0]!;
        assert.equal(s.kind, "forOf");
        if (s.kind !== "forOf") return;
        assert.equal(s.name, "x");
        assert.deepEqual(s.iterable, { kind: "identifier", name: "items" });
        assert.equal(s.body.length, 1);
        assert.equal(s.body[0]!.kind, "const");
    });

    it("rejects a `let` binding", () => {
        const { stmts, diags } = lowerFn(`
            function f(items: number[]): void { for (let x of items) {} }
        `);
        assert.ok(hasCode(diags, KEYMA0204), JSON.stringify(diags));
        assert.equal(stmts.length, 0);
    });

    it("rejects a destructuring binding", () => {
        const { stmts, diags } = lowerFn(`
            function f(items: number[][]): void { for (const [a, b] of items) {} }
        `);
        assert.ok(hasCode(diags, KEYMA0204), JSON.stringify(diags));
        assert.equal(stmts.length, 0);
    });
});

describe("011 — while / break / continue", () => {
    it("lowers a while loop", () => {
        const { stmts, diags } = lowerFn(`
            function f(n: number): void { while (n > 0) { n = n - 1; } }
        `);
        assert.equal(diags.length, 0, JSON.stringify(diags));
        const s = stmts[0]!;
        assert.equal(s.kind, "while");
        if (s.kind !== "while") return;
        assert.equal(s.condition.kind, "binary");
        assert.equal(s.body[0]!.kind, "assign");
    });

    it("lowers break and continue inside a loop", () => {
        const { stmts, diags } = lowerFn(`
            function f(items: number[]): void {
                for (const x of items) {
                    if (x > 5) break;
                    if (x < 0) continue;
                }
            }
        `);
        assert.equal(diags.length, 0, JSON.stringify(diags));
        const forOf = stmts[0]!;
        assert.equal(forOf.kind, "forOf");
        if (forOf.kind !== "forOf") return;
        const if0 = forOf.body[0]!;
        const if1 = forOf.body[1]!;
        assert.equal(if0.kind, "if");
        assert.equal(if1.kind, "if");
        if (if0.kind === "if") assert.equal(if0.consequent[0]!.kind, "break");
        if (if1.kind === "if") assert.equal(if1.consequent[0]!.kind, "continue");
    });

    it("rejects a labeled break", () => {
        const b = build(`function f(): void { outer: while (true) { break outer; } }`);
        const diags: IRDiagnostic[] = [];
        const brk = findFirst(b.sf, ts.isBreakStatement);
        const ir = lowerStatement(brk, portableCtx(b, diags));
        assert.equal(ir, null);
        assert.ok(hasCode(diags, KEYMA0205), JSON.stringify(diags));
    });

    it("rejects a labeled continue", () => {
        const b = build(`function f(): void { outer: while (true) { continue outer; } }`);
        const diags: IRDiagnostic[] = [];
        const cont = findFirst(b.sf, ts.isContinueStatement);
        const ir = lowerStatement(cont, portableCtx(b, diags));
        assert.equal(ir, null);
        assert.ok(hasCode(diags, KEYMA0205), JSON.stringify(diags));
    });
});

describe("011 — C-style for desugars to while", () => {
    it("emits init as leading statements, a while, and a KEYMA0201 warning", () => {
        const { stmts, diags } = lowerFn(`
            function f(): void {
                let total = 0;
                for (let i = 0; i < 10; i = i + 1) { total = total + i; }
            }
        `);
        assert.ok(hasCode(diags, KEYMA0201), JSON.stringify(diags));
        const warning = diags.find((d) => d.code === KEYMA0201);
        assert.equal(warning?.severity, "warning");
        // [const total, const i, while]
        assert.equal(stmts.length, 3);
        assert.equal(stmts[1]!.kind, "const");
        const loop = stmts[2]!;
        assert.equal(loop.kind, "while");
        if (loop.kind !== "while") return;
        assert.equal(loop.condition.kind, "binary");
        // body = [original body…, update step]
        assert.equal(loop.body.length, 2);
        assert.equal(loop.body[1]!.kind, "assign"); // i = i + 1
    });

    it("desugars an `i++` update into an assign", () => {
        const { stmts, diags } = lowerFn(`
            function f(): void { for (let i = 0; i < 3; i++) { } }
        `);
        assert.ok(hasCode(diags, KEYMA0201), JSON.stringify(diags));
        const loop = stmts[stmts.length - 1]!;
        assert.equal(loop.kind, "while");
        if (loop.kind !== "while") return;
        const upd = loop.body[loop.body.length - 1]!;
        assert.equal(upd.kind, "assign");
        if (upd.kind !== "assign") return;
        assert.deepEqual(upd.target, { kind: "identifier", name: "i" });
        assert.equal(upd.value.kind, "binary");
    });

    it("hard-errors on a `continue` inside a C-style for", () => {
        const { stmts, diags } = lowerFn(`
            function f(): void {
                for (let i = 0; i < 10; i++) { if (i === 5) continue; }
            }
        `);
        assert.ok(hasCode(diags, KEYMA0202), JSON.stringify(diags));
        assert.ok(!hasCode(diags, KEYMA0201), "should not also warn when it errors");
        assert.equal(stmts.length, 0);
    });
});

describe("011 — for…in is rejected", () => {
    it("pushes KEYMA0203 and emits nothing", () => {
        const { stmts, diags } = lowerFn(`
            function f(obj: Record<string, number>): void { for (const k in obj) {} }
        `);
        assert.ok(hasCode(diags, KEYMA0203), JSON.stringify(diags));
        assert.equal(stmts.length, 0);
    });
});

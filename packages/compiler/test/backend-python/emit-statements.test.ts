import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRExpression, IRStatement, IRSwitchCase } from "@keyma/core/ir";
import { stmtToPython } from "../../src/backend-python/emit-validators.js";
import { exprToPython } from "../../src/backend-python/emit-expression.js";

// ─── IR builders ──────────────────────────────────────────────────────────────
const id = (name: string): IRExpression => ({ kind: "identifier", name });
const lit = (value: string | number | boolean | null): IRExpression => ({ kind: "literal", value });
const call = (name: string, args: IRExpression[] = []): IRExpression => ({ kind: "call", callee: id(name), args });
const exprStmt = (e: IRExpression): IRStatement => ({ kind: "expression", expr: e });
const brk: IRStatement = { kind: "break" };
const cont: IRStatement = { kind: "continue" };
const ret = (value: IRExpression | null): IRStatement => ({ kind: "return", value });

// ─── 011 loops ────────────────────────────────────────────────────────────────
describe("stmtToPython — loops (011)", () => {
    it("forOf → `for <name> in <iterable>:` with an indented body", () => {
        const s: IRStatement = { kind: "forOf", name: "item", iterable: id("items"), body: [exprStmt(call("use", [id("item")]))] };
        const out = stmtToPython(s, "");
        assert.match(out, /^for item in items:\n {4}use\(item\)$/, out);
    });

    it("an empty forOf body becomes `pass`", () => {
        const s: IRStatement = { kind: "forOf", name: "x", iterable: id("xs"), body: [] };
        const out = stmtToPython(s, "");
        assert.equal(out, "for x in xs:\n    pass");
    });

    it("while → `while <cond>:` with an indented body", () => {
        const s: IRStatement = { kind: "while", condition: id("running"), body: [exprStmt(call("tick"))] };
        const out = stmtToPython(s, "");
        assert.match(out, /^while running:\n {4}tick\(\)$/, out);
    });

    it("break / continue emit natively (and nest at the right indent)", () => {
        const loop: IRStatement = { kind: "while", condition: lit(true), body: [brk, cont] };
        const out = stmtToPython(loop, "");
        assert.equal(out, "while True:\n    break\n    continue");
        // standalone, indented
        assert.equal(stmtToPython(brk, "        "), "        break");
        assert.equal(stmtToPython(cont, "        "), "        continue");
    });
});

// ─── 012 switch ───────────────────────────────────────────────────────────────
describe("stmtToPython — switch (012)", () => {
    const sw = (discriminant: IRExpression, cases: IRSwitchCase[]): IRStatement => ({ kind: "switch", discriminant, cases });

    it("clean cases → `match`/`case`, dropping the implicit break", () => {
        const s = sw(id("status"), [
            { test: lit("active"), body: [exprStmt(call("onActive")), brk] },
            { test: null, body: [exprStmt(call("onOther")), brk] },
        ]);
        const out = stmtToPython(s, "");
        assert.match(out, /^match status:/, out);
        assert.match(out, /case "active":/, out);
        assert.match(out, /case _:/, out); // default → wildcard
        assert.ok(out.includes("onActive()"), out);
        assert.ok(!out.includes("break"), `trailing break must be dropped:\n${out}`);
    });

    it("stacked empty labels collapse to an or-pattern `case A | B:`", () => {
        const s = sw(id("c"), [
            { test: lit("a"), body: [] }, // empty stacked label
            { test: lit("b"), body: [exprStmt(call("ab")), brk] },
            { test: null, body: [exprStmt(call("def_")), brk] },
        ]);
        const out = stmtToPython(s, "");
        assert.match(out, /case "a" \| "b":/, out);
        assert.ok(out.includes("ab()"), out);
    });

    it("mid-body fallthrough desugars to an if/elif + while-carrier (no throw)", () => {
        let out = "";
        assert.doesNotThrow(() => {
            out = stmtToPython(
                sw(id("n"), [
                    // case 1 has a body but NO break → falls through into case 2
                    { test: lit(1), body: [exprStmt(call("doOne"))] },
                    { test: lit(2), body: [exprStmt(call("doTwo")), brk] },
                ]),
                "",
            );
        });
        // entry selector
        assert.match(out, /_kdisc\d+ = n/, out);
        assert.match(out, /_kidx\d+ = -1/, out);
        assert.match(out, /if _kdisc\d+ == 1:/, out);
        assert.match(out, /elif _kdisc\d+ == 2:/, out);
        // one-shot carrier reproducing fallthrough
        assert.match(out, /while True:/, out);
        assert.match(out, /if _kidx\d+ <= 0:/, out);
        assert.match(out, /if _kidx\d+ <= 1:/, out);
        assert.ok(out.includes("doOne()") && out.includes("doTwo()"), out);
        // it is NOT a match statement
        assert.ok(!out.includes("match "), out);
    });

    it("a non-match-safe label (bare identifier) routes to the == based if/elif form", () => {
        const out = stmtToPython(
            sw(id("v"), [
                { test: id("THRESHOLD"), body: [ret(lit(true))] },
                { test: null, body: [ret(lit(false))] },
            ]),
            "",
        );
        // == comparison rather than a capture-pattern `case THRESHOLD:`
        assert.match(out, /== THRESHOLD:/, out);
        assert.ok(!out.includes("match "), out);
    });

    it("a default that is not last routes to the ordered if/elif form", () => {
        const out = stmtToPython(
            sw(id("k"), [
                { test: null, body: [exprStmt(call("d")), brk] }, // default first
                { test: lit("x"), body: [exprStmt(call("x")), brk] },
            ]),
            "",
        );
        assert.ok(!out.includes("match "), out);
        assert.match(out, /while True:/, out);
    });
});

// ─── 010 await ────────────────────────────────────────────────────────────────
describe("exprToPython — await (010)", () => {
    it("await <call> → `await call()`", () => {
        const e: IRExpression = { kind: "await", operand: call("fetch") };
        assert.equal(exprToPython(e), "await fetch()");
    });

    it("parenthesizes a complex operand", () => {
        const e: IRExpression = {
            kind: "await",
            operand: { kind: "conditional", condition: id("ok"), whenTrue: call("a"), whenFalse: call("b") },
        };
        assert.equal(exprToPython(e), "await (a() if ok else b())");
    });
});

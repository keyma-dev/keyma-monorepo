import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRExpression, IRStatement } from "@keyma/core/ir";
import { exprToJs, stmtToJs } from "../../src/backend-js/emit-expression.js";

// ─── Small IR builders ──────────────────────────────────────────────────────
const id = (name: string): IRExpression => ({ kind: "identifier", name });
const lit = (value: string | number | boolean | null): IRExpression => ({ kind: "literal", value });
const call = (callee: string, ...args: IRExpression[]): IRExpression => ({
    kind: "call",
    callee: id(callee),
    args,
});
const exprStmt = (expr: IRExpression): IRStatement => ({ kind: "expression", expr });

// ─── 011 loops ──────────────────────────────────────────────────────────────
describe("stmtToJs — loops (011)", () => {
    it("emits forOf as a native for…of with an indented body", () => {
        const out = stmtToJs(
            { kind: "forOf", name: "x", iterable: id("items"), body: [exprStmt(call("use", id("x")))] },
            "",
        );
        assert.match(out, /^for \(const x of items\) \{/);
        assert.ok(out.includes("    use(x);"), out);
        assert.ok(out.trimEnd().endsWith("}"), out);
    });

    it("emits while as a native while loop", () => {
        const out = stmtToJs(
            {
                kind: "while",
                condition: { kind: "binary", op: "<", left: id("i"), right: lit(10) },
                body: [{ kind: "break" }],
            },
            "",
        );
        assert.match(out, /^while \(i < 10\) \{/);
        assert.ok(out.includes("    break;"), out);
    });

    it("emits break / continue natively with the given indent", () => {
        assert.equal(stmtToJs({ kind: "break" }, ""), "break;");
        assert.equal(stmtToJs({ kind: "continue" }, "  "), "  continue;");
    });
});

// ─── 012 switch ─────────────────────────────────────────────────────────────
describe("stmtToJs — switch (012)", () => {
    const sw: IRStatement = {
        kind: "switch",
        discriminant: id("kind"),
        cases: [
            // No break ⇒ source-faithful fallthrough into the next case.
            { test: lit("a"), body: [exprStmt(call("doA"))] },
            { test: lit("b"), body: [exprStmt(call("doB")), { kind: "break" }] },
            // test: null ⇒ default arm.
            { test: null, body: [exprStmt(call("fallback"))] },
        ],
    };

    it("emits a native switch with case / default labels", () => {
        const out = stmtToJs(sw, "");
        assert.match(out, /^switch \(kind\) \{/);
        assert.ok(out.includes('case "a":'), out);
        assert.ok(out.includes('case "b":'), out);
        assert.ok(out.includes("default:"), out);
        assert.ok(out.includes("doB();"), out);
        assert.ok(out.includes("break;"), out);
        assert.ok(out.includes("fallback();"), out);
    });

    it("preserves fallthrough — case 'a' has no break before case 'b'", () => {
        const out = stmtToJs(sw, "");
        const between = out.slice(out.indexOf('case "a":'), out.indexOf('case "b":'));
        assert.ok(!between.includes("break;"), `expected fallthrough, got: ${between}`);
    });
});

// ─── 010 await ──────────────────────────────────────────────────────────────
describe("exprToJs — await (010)", () => {
    it("emits a bare await for a simple operand", () => {
        assert.equal(exprToJs({ kind: "await", operand: id("p") }), "await p");
    });

    it("does not over-parenthesize a call operand", () => {
        assert.equal(exprToJs({ kind: "await", operand: call("fetchUser") }), "await fetchUser()");
    });

    it("parenthesizes a complex (binary) operand", () => {
        assert.equal(
            exprToJs({ kind: "await", operand: { kind: "binary", op: "+", left: id("a"), right: id("b") } }),
            "await (a + b)",
        );
    });

    it("parenthesizes an await result accessed as a member", () => {
        assert.equal(
            exprToJs({ kind: "member", object: { kind: "await", operand: id("p") }, member: "value" }),
            "(await p).value",
        );
    });
});

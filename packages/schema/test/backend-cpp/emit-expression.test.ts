import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INTRINSICS } from "@keyma/core/ir";
import type { IRExpression } from "@keyma/core/ir";
import { exprToCpp } from "@keyma/compiler/backend-cpp";
import { lit, id, fieldRef, intr, tmpl } from "./fixtures.js";

describe("exprToCpp — expression kinds", () => {
    it("literals", () => {
        assert.equal(exprToCpp(lit(true)), "true");
        assert.equal(exprToCpp(lit(false)), "false");
        assert.equal(exprToCpp(lit(null)), "nullptr");
        assert.equal(exprToCpp(lit("hi")), '"hi"');
        assert.equal(exprToCpp(lit(42)), "42");
    });

    it("field access defaults to this->", () => {
        assert.equal(exprToCpp(fieldRef("x")), "this->x");
    });

    it("field access honours a custom fieldExpr (value context)", () => {
        assert.equal(exprToCpp(fieldRef("x"), { fieldExpr: (n) => `value.at("${n}")` }), 'value.at("x")');
    });

    it("identifier undefined → nullptr", () => {
        assert.equal(exprToCpp(id("undefined")), "nullptr");
        assert.equal(exprToCpp(id("value")), "value");
    });

    it("template → std::format", () => {
        assert.equal(exprToCpp(tmpl(id("a"), lit(" x "), id("b"))), 'std::format("{} x {}", a, b)');
    });

    it("template with no interpolation → string literal", () => {
        assert.equal(exprToCpp(tmpl(lit("plain"))), '"plain"');
    });

    it("binary: ?? → coalesce, && stays &&, comparison passes through", () => {
        assert.equal(exprToCpp({ kind: "binary", op: "??", left: id("a"), right: id("b") }), "keyma::coalesce(a, b)");
        assert.equal(exprToCpp({ kind: "binary", op: "&&", left: id("a"), right: id("b") }), "a && b");
        assert.equal(exprToCpp({ kind: "binary", op: "<", left: id("a"), right: lit(3) }), "a < 3");
    });

    it("conditional → ternary", () => {
        assert.equal(
            exprToCpp({ kind: "conditional", condition: id("c"), whenTrue: id("t"), whenFalse: id("f") }),
            "(c ? t : f)",
        );
    });

    it("regexp → keyma::make_regex", () => {
        assert.equal(exprToCpp({ kind: "regexp", pattern: "^a$", flags: "i" }), 'keyma::make_regex("^a$", "i")');
    });

    it("arrow → C++ lambda", () => {
        assert.equal(
            exprToCpp({ kind: "arrow", params: ["x"], body: { kind: "binary", op: ">", left: id("x"), right: lit(0) } }),
            "[&](auto x) { return x > 0; }",
        );
    });

    it("block-body arrow → statement lambda with explicit `-> bool` return type", () => {
        const arrow: IRExpression = {
            kind: "arrow", params: ["n"],
            statements: [
                { kind: "const", name: "x", init: { kind: "binary", op: "*", left: id("n"), right: lit(2) } },
                { kind: "return", value: { kind: "binary", op: ">", left: id("x"), right: lit(10) } },
            ],
            returnType: { kind: "boolean" },
        };
        assert.equal(exprToCpp(arrow), "[&](auto n) -> bool {\n    auto x = n * 2;\n    return x > 10;\n}");
    });

    it("block-body arrow without a known return type omits the explicit type (auto)", () => {
        const arrow: IRExpression = {
            kind: "arrow", params: ["n"],
            statements: [{ kind: "return", value: id("n") }],
            // returnType absent (e.g. an array/enum element) → `auto` deduction
        };
        assert.equal(exprToCpp(arrow), "[&](auto n) {\n    return n;\n}");
    });

    it("new Date() / components / RegExp", () => {
        assert.equal(exprToCpp({ kind: "new", callee: id("Date"), args: [] }), "keyma::date_now()");
        assert.equal(
            exprToCpp({ kind: "new", callee: id("Date"), args: [lit(2020), lit(0), lit(15)] }),
            "keyma::date_from_components(2020, 0, 15)",
        );
        assert.equal(exprToCpp({ kind: "new", callee: id("RegExp"), args: [lit("a")] }), 'keyma::make_regex("a", "")');
    });
});

describe("intrinsic lowering", () => {
    const SPOTS: Record<string, string> = {
        "string.includes": "keyma::includes(s, \"x\")",
        "string.startsWith": "keyma::starts_with(s, \"x\")",
        "string.toLowerCase": "keyma::to_lower(s)",
        "string.length": "keyma::length(s)",
        "array.length": "keyma::length(s)",
        "regexp.test": "keyma::regex_test(s, \"x\")",
        "date.getMonth": "keyma::date_month0(s)",
        "date.now": "keyma::date_get_time(keyma::date_now())",
    };

    for (const [op, expected] of Object.entries(SPOTS)) {
        it(`lowers ${op}`, () => {
            const recv = op === "date.now" ? null : id("s");
            const args = op === "regexp.test" || op.endsWith("includes") || op.endsWith("startsWith") ? [lit("x")] : [];
            assert.equal(exprToCpp(intr(op, recv, args)), expected);
        });
    }

    it("type-is / instance-of read the literal type name", () => {
        assert.equal(exprToCpp(intr("type-is", id("v"), [lit("string")])), 'keyma::type_is(v, "string")');
        assert.equal(exprToCpp(intr("instance-of", id("v"), [lit("Array")])), 'keyma::instance_of(v, "Array")');
    });

    it("every required intrinsic lowers to a keyma:: helper (no unsupported markers)", () => {
        for (const def of INTRINSICS) {
            const recv: IRExpression | null = def.receiver === "value" ? null : id("recv");
            const args: IRExpression[] = [];
            for (let i = 0; i < def.minArgs; i++) args.push(def.op === "type-is" ? lit("string") : def.op === "instance-of" ? lit("Date") : lit("x"));
            const out = exprToCpp(intr(def.op, recv, args));
            assert.ok(!out.includes("unsupported_intrinsic"), `${def.op} produced an unsupported marker: ${out}`);
            // `self` lowers to the C++ receiver `(*this)`, not a keyma:: helper.
            if (def.op === "self") { assert.equal(out, "(*this)"); continue; }
            assert.ok(out.startsWith("keyma::"), `${def.op} did not map to a keyma:: helper: ${out}`);
        }
    });
});

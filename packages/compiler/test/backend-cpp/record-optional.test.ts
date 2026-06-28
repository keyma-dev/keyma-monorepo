import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { record, optional, external, literal, intrinsic, defaultIntrinsics } from "@keyma/core/ir";
import { exprToCpp, type ExprOpts } from "../../src/backend-cpp/emit-expression.js";
import { irTypeToCpp } from "../../src/backend-cpp/ir-type-to-cpp.js";
import { defaultRuntimeSymbols, defaultRecordLayouts } from "../../src/driver/runtime-symbols.js";

// A minimal `error.collect` registration (mirrors the schema domain's) so the C++ emitter's
// domain-intrinsic default branch threads `opts.allocVar` through to the native snippet.
defaultIntrinsics.register({
    op: "error.collect", receiver: "value", form: "method", tsName: "", minArgs: 0, maxArgs: 255, tier: "required",
    emit: { cpp: (_recv, args, opts) => `keyma::collect_errors(${opts?.allocVar ?? "{}"}, ${args.join(", ")})` },
});

// Register the schema runtime-contract entries the C++ record/type emission consults (the same
// data the schema domain registers in a real build). Module-level singletons; additive.
defaultRuntimeSymbols.register("ValidationError", { cpp: "keyma::ValidationError" });
defaultRuntimeSymbols.register("ValidatorCtx", { cpp: "keyma::ValidatorCtx" });
defaultRecordLayouts.register("ValidationError", {
    fields: [
        { key: "field", ctor: "pmrString" },
        { key: "code", ctor: "pmrString" },
        { key: "message", ctor: "pmrString" },
    ],
    style: "designated",
});
defaultRecordLayouts.register("ValidatorCtx", {
    fields: [{ key: "object", ctor: "passthrough" }],
    style: "positional",
});

const OPTS: ExprOpts = { fieldExpr: (n) => `this->${n}`, allocVar: "__a" };

describe("C++ — record expression (typed aggregate via the layout table)", () => {
    it("ValidationError → designated init in DECLARATION order, pmr-strings on the alloc var", () => {
        // Authored out of order — emission must follow the layout's declaration order.
        const r = record(external("ValidationError"), {
            code: literal("minLength"),
            message: literal("too short"),
            field: literal("firstName"),
        });
        assert.equal(
            exprToCpp(r, OPTS),
            'keyma::ValidationError{.field = std::pmr::string("firstName", __a), ' +
            '.code = std::pmr::string("minLength", __a), ' +
            '.message = std::pmr::string("too short", __a)}',
        );
    });

    it("ValidatorCtx → positional CTAD with the passthrough value", () => {
        const r = record(external("ValidatorCtx"), { object: intrinsic("self", null, []) });
        assert.equal(exprToCpp(r, OPTS), "keyma::ValidatorCtx{(*this)}");
    });

    it("absent allocVar falls back to a default-constructed allocator `{}`", () => {
        const r = record(external("ValidationError"), { field: literal("x") });
        assert.equal(
            exprToCpp(r, { fieldExpr: (n) => `this->${n}` }),
            'keyma::ValidationError{.field = std::pmr::string("x", {})}',
        );
    });

    it("an unregistered record type falls back to positional aggregate init", () => {
        const r = record(external("Unknown"), { a: literal(1), b: literal(2) });
        assert.equal(exprToCpp(r, OPTS), "Unknown{1, 2}");
    });
});

describe("C++ — error.collect intrinsic threads the method allocVar", () => {
    it("emits keyma::collect_errors(<allocVar>, …)", () => {
        const e = intrinsic("error.collect", null, [literal("a"), literal("b")]);
        assert.equal(exprToCpp(e, OPTS), 'keyma::collect_errors(__a, "a", "b")');
    });

    it("falls back to `{}` when no allocVar is in scope", () => {
        const e = intrinsic("error.collect", null, [literal("a")]);
        assert.equal(exprToCpp(e, { fieldExpr: (n) => `this->${n}` }), 'keyma::collect_errors({}, "a")');
    });
});

describe("C++ — optional type", () => {
    it("optional renders `std::optional<T>`", () => {
        assert.equal(irTypeToCpp(optional(external("ValidationError"))), "std::optional<keyma::ValidationError>");
        assert.equal(irTypeToCpp(optional({ kind: "string" })), "std::optional<std::pmr::string>");
    });
});

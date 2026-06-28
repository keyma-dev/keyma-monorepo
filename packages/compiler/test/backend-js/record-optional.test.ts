import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { record, optional, external, fnType, param, literal, field } from "@keyma/core/ir";
import { exprToJs } from "../../src/backend-js/emit-expression.js";
import { irTypeToTs } from "../../src/backend-js/ir-type-to-ts.js";

describe("JS — record expression (typed object, type erased)", () => {
    it("emits a record as a plain object literal", () => {
        const r = record(external("ValidationError"), {
            field: field("firstName"),
            code: literal("minLength"),
            message: literal("too short"),
        });
        assert.equal(
            exprToJs(r),
            '{ "field": this.firstName, "code": "minLength", "message": "too short" }',
        );
    });
});

describe("JS — optional + function types", () => {
    it("optional renders `T | null`", () => {
        assert.equal(irTypeToTs(optional(external("ValidationError"))), "ValidationError | null");
        assert.equal(irTypeToTs(optional({ kind: "string" })), "string | null");
    });

    it("function type renders `(p: T) => R` (gap #6b)", () => {
        const fn = fnType([param("value", { kind: "string" })], optional(external("ValidationError")));
        assert.equal(irTypeToTs(fn), "(value: string) => ValidationError | null");
    });

    it("a void function type (absent returns) renders `=> void`", () => {
        assert.equal(irTypeToTs(fnType([param("x", { kind: "number" })])), "(x: number) => void");
    });
});

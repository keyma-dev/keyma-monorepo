import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { record, optional, external, literal, field } from "@keyma/core/ir";
import { exprToPython } from "../../src/backend-python/emit-expression.js";
import { irTypeToPython } from "../../src/backend-python/ir-type-to-python.js";

describe("Python — record expression (typed object, type erased)", () => {
    it("emits a record as a plain dict literal", () => {
        const r = record(external("ValidationError"), {
            field: field("firstName"),
            code: literal("minLength"),
            message: literal("too short"),
        });
        assert.equal(
            exprToPython(r),
            '{ "field": self.firstName, "code": "minLength", "message": "too short" }',
        );
    });
});

describe("Python — optional type", () => {
    it("optional renders `Optional[T]`", () => {
        assert.equal(irTypeToPython(optional(external("ValidationError"))), "Optional[ValidationError]");
        assert.equal(irTypeToPython(optional({ kind: "string" })), "Optional[str]");
    });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/validate.js";
import type { SchemaMetadata, ValidatorFn, FieldMetadata } from "../src/types.js";

function schema(fields: SchemaMetadata["fields"]): SchemaMetadata {
    return { name: "test", sourceName: "Test", fields };
}

function field(name: string, validators: ValidatorFn[]): FieldMetadata {
    return { name, type: { kind: "string" }, required: false, validators };
}

const isEven: ValidatorFn = (raw, fieldName) =>
    typeof raw === "number" && raw % 2 === 0 ? null : { field: fieldName, code: "isEven", message: `${fieldName} must be even` };

const minLength = (n: number): ValidatorFn => (raw, fieldName) =>
    typeof raw === "string" && raw.length < n ? { field: fieldName, code: "minLength", message: "" } : null;

describe("validate — direct-ref validators", () => {
    it("runs a validator attached directly to the field metadata", async () => {
        const s = schema([{ name: "n", type: { kind: "number" }, required: false, validators: [isEven] }]);
        const errors = await validate(s, { n: 3 });
        assert.equal(errors.length, 1);
        assert.equal(errors[0]!.code, "isEven");
    });

    it("a passing validator yields no error", async () => {
        const s = schema([{ name: "n", type: { kind: "number" }, required: false, validators: [isEven] }]);
        assert.deepEqual(await validate(s, { n: 4 }), []);
    });

    it("fields without validators are no-ops", async () => {
        const s = schema([field("email", [])]);
        assert.deepEqual(await validate(s, {}), []);
    });

    it("a parameterized validator factory closes over its params", async () => {
        const s = schema([field("name", [minLength(3)])]);
        const errors = await validate(s, { name: "ab" });
        assert.equal(errors.length, 1);
        assert.equal(errors[0]!.code, "minLength");
    });

    it("runs every validator on a field, accumulating errors", async () => {
        const fail = (code: string): ValidatorFn => (_v, f) => ({ field: f, code, message: "" });
        const s = schema([field("x", [fail("a"), fail("b")])]);
        const errors = await validate(s, { x: "v" });
        assert.deepEqual(errors.map((e) => e.code), ["a", "b"]);
    });

    it("awaits async validators", async () => {
        const asyncFail: ValidatorFn = async (_v, f) => ({ field: f, code: "async", message: "" });
        const s = schema([field("x", [asyncFail])]);
        const errors = await validate(s, { x: "v" });
        assert.equal(errors[0]!.code, "async");
    });
});

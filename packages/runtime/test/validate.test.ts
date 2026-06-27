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
    it("runs a validator attached directly to the field metadata", () => {
        const s = schema([{ name: "n", type: { kind: "number" }, required: false, validators: [isEven] }]);
        const errors = validate(s, { n: 3 });
        assert.equal(errors.length, 1);
        assert.equal(errors[0]!.code, "isEven");
    });

    it("a passing validator yields no error", () => {
        const s = schema([{ name: "n", type: { kind: "number" }, required: false, validators: [isEven] }]);
        assert.deepEqual(validate(s, { n: 4 }), []);
    });

    it("fields without validators are no-ops", () => {
        const s = schema([field("email", [])]);
        assert.deepEqual(validate(s, {}), []);
    });

    it("a parameterized validator factory closes over its params", () => {
        const s = schema([field("name", [minLength(3)])]);
        const errors = validate(s, { name: "ab" });
        assert.equal(errors.length, 1);
        assert.equal(errors[0]!.code, "minLength");
    });

    it("runs every validator on a field, accumulating errors", () => {
        const fail = (code: string): ValidatorFn => (_v, f) => ({ field: f, code, message: "" });
        const s = schema([field("x", [fail("a"), fail("b")])]);
        const errors = validate(s, { x: "v" });
        assert.deepEqual(errors.map((e) => e.code), ["a", "b"]);
    });

    it("a missing required field fails with code 'required'", () => {
        const s = schema([{ name: "id", type: { kind: "id" } }]);
        const errors = validate(s, {});
        assert.equal(errors.length, 1);
        assert.equal(errors[0]!.code, "required");
        assert.equal(errors[0]!.field, "id");
    });

    it("a missing optional field is skipped", () => {
        const s = schema([field("nickname", [minLength(3)])]);
        assert.deepEqual(validate(s, {}), []);
    });

    it("validates inherited fields by walking the base chain", () => {
        const base: SchemaMetadata = {
            name: "base", sourceName: "Base",
            fields: [field("name", [minLength(3)])],
        };
        const leaf: SchemaMetadata = {
            name: "leaf", sourceName: "Leaf", base,
            fields: [field("nick", [minLength(2)])],
        };
        const errors = validate(leaf, { name: "ab", nick: "x" });
        assert.deepEqual(errors.map((e) => e.code), ["minLength", "minLength"]);
        assert.deepEqual(errors.map((e) => e.field), ["name", "nick"]);
    });
});

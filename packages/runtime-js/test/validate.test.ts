import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    validate,
    createDefaultValidatorRegistry,
    type ValidatorRegistry,
} from "../src/validate.js";
import type { SchemaMetadata, ValidatorSpec, FieldMetadata } from "../src/types.js";

function schema(fields: SchemaMetadata["fields"]): SchemaMetadata {
    return {
        name: "test",
        sourceName: "Test",
        fields,
    };
}

function field(name: string, validators: ValidatorSpec[]): FieldMetadata {
    return {
        name,
        type: { kind: "string" },
        required: false,
        validators,
    };
}

describe("validate — default registry", () => {
    it("returns no errors when all rules pass", async () => {
        const s = schema([field("email", [{ kind: "required" }, { kind: "emailAddress" }])]);
        const errors = await validate(s, { email: "user@example.com" });
        assert.deepEqual(errors, []);
    });

    it("required: flags missing values", async () => {
        const s = schema([field("email", [{ kind: "required" }])]);
        const errors = await validate(s, {});
        assert.equal(errors.length, 1);
        assert.equal(errors[0]!.code, "required");
    });

    it("minLength / maxLength / length", async () => {
        const s = schema([
            field("a", [{ kind: "minLength", value: 3 }]),
            field("b", [{ kind: "maxLength", value: 5 }]),
            field("c", [{ kind: "length", value: 4 }]),
        ]);
        const errors = await validate(s, { a: "hi", b: "toolong", c: "no" });
        const codes = errors.map((e) => e.code).sort();
        assert.deepEqual(codes, ["length", "maxLength", "minLength"]);
    });

    it("numeric range checks", async () => {
        const s = schema([
            {
                name: "n",
                type: { kind: "number" },
                required: false,
                validators: [
                    { kind: "min", value: 1 },
                    { kind: "max", value: 10 },
                    { kind: "positive" },
                    { kind: "integer" },
                ],
            },
        ]);
        const errors = await validate(s, { n: -1.5 });
        const codes = errors.map((e) => e.code).sort();
        assert.deepEqual(codes, ["integer", "min", "positive"]);
    });

    it("emailAddress / pattern / oneOf", async () => {
        const s = schema([
            field("email", [{ kind: "emailAddress" }]),
            field("color", [{ kind: "oneOf", values: ["red", "blue"] }]),
            field("code", [{ kind: "pattern", pattern: "^[A-Z]+$" }]),
        ]);
        const errors = await validate(s, { email: "nope", color: "green", code: "abc" });
        const codes = errors.map((e) => e.code).sort();
        assert.deepEqual(codes, ["emailAddress", "oneOf", "pattern"]);
    });

    it("uniqueItems / minItems / maxItems on arrays", async () => {
        const s = schema([
            {
                name: "tags",
                type: { kind: "array", of: { kind: "string" } },
                required: false,
                validators: [
                    { kind: "minItems", value: 2 },
                    { kind: "maxItems", value: 3 },
                    { kind: "uniqueItems" },
                ],
            },
        ]);
        const errors = await validate(s, { tags: ["a", "a"] });
        const codes = errors.map((e) => e.code).sort();
        assert.deepEqual(codes, ["uniqueItems"]);
    });
});

describe("validate — custom registry", () => {
    it("uses a custom validator registered by kind", async () => {
        const registry: ValidatorRegistry = createDefaultValidatorRegistry();
        registry.set("isEven", (raw, _spec, fieldName, _context) =>
            typeof raw === "number" && raw % 2 === 0
                ? null
                : { field: fieldName, code: "isEven", message: `${fieldName} must be even` },
        );
        const s = schema([
            {
                name: "n",
                type: { kind: "number" },
                required: false,
                validators: [{ kind: "isEven" }],
            },
        ]);
        const errors = await validate(s, { n: 3 }, registry);
        assert.equal(errors.length, 1);
        assert.equal(errors[0]!.code, "isEven");
    });

    it("unknown kinds in spec are silently skipped", async () => {
        const s = schema([field("x", [{ kind: "doesNotExist" }])]);
        const errors = await validate(s, { x: "value" });
        assert.deepEqual(errors, []);
    });
});

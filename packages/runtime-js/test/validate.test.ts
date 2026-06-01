import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    validate,
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

describe("validate — custom registry", () => {
    it("uses a custom validator registered by name", async () => {
        const registry: ValidatorRegistry = new Map();
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
                validators: [{ name: "isEven" }],
            },
        ]);
        const errors = await validate(s, { n: 3 }, registry);
        assert.equal(errors.length, 1);
        assert.equal(errors[0]!.code, "isEven");
    });

    it("unknown names in spec are silently skipped", async () => {
        const s = schema([field("x", [{ name: "doesNotExist" }])]);
        const errors = await validate(s, { x: "value" }, new Map());
        assert.deepEqual(errors, []);
    });

    it("default registry is empty — validators are no-ops without an explicit registry", async () => {
        const s = schema([field("email", [{ name: "required" }])]);
        const errors = await validate(s, {});
        assert.deepEqual(errors, []);
    });

    it("flattenParams: params nested under params key are spread into spec for registry fn", async () => {
        const registry: ValidatorRegistry = new Map();
        registry.set("minLength", (raw, spec, fieldName) => {
            const min = typeof spec["value"] === "number" ? spec["value"] : 0;
            return typeof raw === "string" && raw.length < min
                ? { field: fieldName, code: "minLength", message: "" }
                : null;
        });
        const s = schema([field("name", [{ name: "minLength", params: { value: 3 } }])]);
        const errors = await validate(s, { name: "ab" }, registry);
        assert.equal(errors.length, 1);
        assert.equal(errors[0]!.code, "minLength");
    });
});

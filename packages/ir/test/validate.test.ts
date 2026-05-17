import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateIR } from "../src/validate.js";

const minimalSource = { file: "src/user.ts", line: 1, column: 0 };

const minimalField = {
    name: "id",
    type: { kind: "id" as const },
    visibility: "public" as const,
    readonly: true,
    required: true,
    validators: [] as unknown[],
    formatters: [] as unknown[],
    indexes: [] as unknown[],
    source: minimalSource,
};

const minimalSchema = {
    id: "schema:user",
    name: "user",
    sourceName: "User",
    visibility: "public" as const,
    fields: [minimalField],
    indexes: [] as unknown[],
    source: minimalSource,
};

const goldenIR = {
    irVersion: "1.0.0",
    compilerVersion: "0.1.0",
    schemas: [minimalSchema],
    diagnostics: [] as unknown[],
};

describe("validateIR", () => {
    it("accepts a minimal valid IR document", () => {
        const result = validateIR(goldenIR);
        assert.equal(result.valid, true);
        assert.deepEqual(result.errors, []);
    });

    it("rejects non-object input", () => {
        const result = validateIR("not an object");
        assert.equal(result.valid, false);
        assert.ok(result.errors.length > 0);
    });

    it("rejects missing irVersion", () => {
        const doc = { ...goldenIR, irVersion: 42 };
        const result = validateIR(doc);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some(e => e.path === "irVersion"));
    });

    it("rejects missing schemas array", () => {
        const doc = { ...goldenIR, schemas: "nope" };
        const result = validateIR(doc);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some(e => e.path === "schemas"));
    });

    it("rejects invalid schema visibility", () => {
        const doc = {
            ...goldenIR,
            schemas: [{ ...minimalSchema, visibility: "maybe" }],
        };
        const result = validateIR(doc);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some(e => e.path.includes("visibility")));
    });

    it("rejects invalid field type kind", () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                fields: [{ ...minimalField, type: { kind: "unknownKind" } }],
            }],
        };
        const result = validateIR(doc);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some(e => e.message.includes("unknownKind")));
    });

    it("accepts all scalar type kinds", () => {
        const scalarKinds = [
            "string", "number", "integer", "bigint", "decimal",
            "boolean", "bytes", "json", "date", "dateTime", "time", "id",
        ];
        for (const kind of scalarKinds) {
            const doc = {
                ...goldenIR,
                schemas: [{
                    ...minimalSchema,
                    fields: [{ ...minimalField, type: { kind } }],
                }],
            };
            const result = validateIR(doc);
            assert.equal(result.valid, true, `Expected valid for kind "${kind}", got errors: ${JSON.stringify(result.errors)}`);
        }
    });

    it("accepts enum type with values", () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                fields: [{ ...minimalField, type: { kind: "enum", values: ["draft", "published"] } }],
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("rejects enum type with empty values", () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                fields: [{ ...minimalField, type: { kind: "enum", values: [] } }],
            }],
        };
        assert.equal(validateIR(doc).valid, false);
    });

    it("accepts nullable and array types", () => {
        const nullable = { kind: "nullable", of: { kind: "string" } };
        const array = { kind: "array", of: { kind: "number" } };
        for (const type of [nullable, array]) {
            const doc = {
                ...goldenIR,
                schemas: [{ ...minimalSchema, fields: [{ ...minimalField, type }] }],
            };
            assert.equal(validateIR(doc).valid, true);
        }
    });

    it("accepts reference and embedded types", () => {
        for (const kind of ["reference", "embedded"]) {
            const doc = {
                ...goldenIR,
                schemas: [{
                    ...minimalSchema,
                    fields: [{ ...minimalField, type: { kind, schema: "Address" } }],
                }],
            };
            assert.equal(validateIR(doc).valid, true);
        }
    });

    it("accepts all scalar validators", () => {
        const scalarValidators = [
            { kind: "required" }, { kind: "positive" }, { kind: "nonNegative" },
            { kind: "negative" }, { kind: "nonPositive" }, { kind: "integer" },
            { kind: "uniqueItems" }, { kind: "emailAddress" },
        ];
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                fields: [{ ...minimalField, validators: scalarValidators }],
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("accepts numeric validators", () => {
        const numericValidators = [
            { kind: "minLength", value: 2 }, { kind: "maxLength", value: 32 },
            { kind: "length", value: 10 }, { kind: "min", value: 0 },
            { kind: "max", value: 100 }, { kind: "multipleOf", value: 5 },
            { kind: "minItems", value: 1 }, { kind: "maxItems", value: 10 },
        ];
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                fields: [{ ...minimalField, validators: numericValidators }],
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("rejects unknown validator kind", () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                fields: [{ ...minimalField, validators: [{ kind: "madeUp" }] }],
            }],
        };
        assert.equal(validateIR(doc).valid, false);
    });

    it("accepts formatters with all phases", () => {
        const formatters = [
            { phase: "change", spec: { kind: "trim" } },
            { phase: "blur", spec: { kind: "lowercase" } },
            { phase: "submit", spec: { kind: "normalizeEmail" } },
            { phase: "save", spec: { kind: "slugify" } },
        ];
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                fields: [{ ...minimalField, formatters }],
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("rejects invalid formatter phase", () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                fields: [{
                    ...minimalField,
                    formatters: [{ phase: "midnight", spec: { kind: "trim" } }],
                }],
            }],
        };
        assert.equal(validateIR(doc).valid, false);
    });

    it("accepts truncate formatter with maxLength", () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                fields: [{
                    ...minimalField,
                    formatters: [{ phase: "save", spec: { kind: "truncate", maxLength: 50 } }],
                }],
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("accepts composite index", () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                indexes: [{ fields: [{ name: "email", direction: 1 }, { name: "createdAt", direction: -1 }], unique: true }],
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("accepts a field with a computed expression", () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                fields: [{
                    ...minimalField,
                    name: "fullName",
                    type: { kind: "string" },
                    computed: {
                        expression: {
                            kind: "template",
                            parts: [
                                { kind: "field", name: "firstName" },
                                { kind: "literal", value: " " },
                                { kind: "field", name: "lastName" },
                            ],
                        },
                    },
                }],
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("accepts diagnostics", () => {
        const doc = {
            ...goldenIR,
            diagnostics: [{
                code: "KEYMA001",
                severity: "error",
                message: "Duplicate schema name",
                source: minimalSource,
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("rejects invalid diagnostic severity", () => {
        const doc = {
            ...goldenIR,
            diagnostics: [{ code: "KEYMA001", severity: "fatal", message: "oops" }],
        };
        assert.equal(validateIR(doc).valid, false);
    });

    it("golden IR document round-trips through JSON", () => {
        const serialized = JSON.stringify(goldenIR);
        const parsed = JSON.parse(serialized) as unknown;
        const result = validateIR(parsed);
        assert.equal(result.valid, true);
    });
});

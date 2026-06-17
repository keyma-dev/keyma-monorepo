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

    it("accepts an ephemeral schema and an ephemeral field", () => {
        const doc = {
            ...goldenIR,
            schemas: [
                {
                    ...minimalSchema,
                    ephemeral: true,
                    fields: [{ ...minimalField, ephemeral: true }],
                },
            ],
        };
        const result = validateIR(doc);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
        assert.deepEqual(result.errors, []);
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
            { name: "required" }, { name: "positive" }, { name: "nonNegative" },
            { name: "negative" }, { name: "nonPositive" }, { name: "integer" },
            { name: "uniqueItems" }, { name: "emailAddress" },
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
            { name: "minLength", params: { value: 2 } }, { name: "maxLength", params: { value: 32 } },
            { name: "length", params: { value: 10 } }, { name: "min", params: { value: 0 } },
            { name: "max", params: { value: 100 } }, { name: "multipleOf", params: { value: 5 } },
            { name: "minItems", params: { value: 1 } }, { name: "maxItems", params: { value: 10 } },
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
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                fields: [{ ...minimalField, validators: [{ kind: "madeUp" }] as any }],
            }],
        };
        assert.equal(validateIR(doc).valid, false);
    });

    it("accepts formatters with all phases", () => {
        const formatters = [
            { phase: "change", spec: { name: "trim" } },
            { phase: "blur", spec: { name: "lowercase" } },
            { phase: "submit", spec: { name: "normalizeEmail" } },
            { phase: "save", spec: { name: "slugify" } },
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
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    formatters: [{ phase: "midnight", spec: { name: "trim" } }] as any,
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
                    formatters: [{ phase: "save", spec: { name: "truncate", params: { maxLength: 50 } } }],
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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateIR, defaultIRValidators } from "@keyma/core/ir";
import { schemaIRValidator } from "../src/index.js";

// The core `validateIR` registry carries only the domain-neutral envelope checks;
// register the schema-domain section checks (the unit under test) onto it, exactly
// as the CLI does at startup.
defaultIRValidators.register(schemaIRValidator);

const minimalSource = { file: "src/user.ts", line: 1, column: 0 };

const minimalField = {
    name: "id",
    type: { kind: "id" as const },
    visibility: "public" as const,
    readonly: true,
    required: true,
    validators: [] as unknown[],
    formatters: [] as unknown[],
    source: minimalSource,
};

const minimalSchema = {
    id: "schema:user",
    name: "user",
    sourceName: "User",
    visibility: "public" as const,
    fields: [minimalField],
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
                    extensions: { schema: { ephemeral: true } },
                    fields: [{ ...minimalField, extensions: { schema: { ephemeral: true } } }],
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

    it("accepts numeric kinds with valid bits/unsigned metadata", () => {
        const validTypes = [
            { kind: "integer", bits: 8, unsigned: true },
            { kind: "integer", bits: 16 },
            { kind: "integer", bits: 64 },
            { kind: "integer", unsigned: true },
            { kind: "number", bits: 32 },
            { kind: "number", bits: 64 },
        ];
        for (const type of validTypes) {
            const doc = {
                ...goldenIR,
                schemas: [{ ...minimalSchema, fields: [{ ...minimalField, type }] }],
            };
            const result = validateIR(doc);
            assert.equal(result.valid, true, `Expected valid for ${JSON.stringify(type)}, got: ${JSON.stringify(result.errors)}`);
        }
    });

    it("rejects numeric kinds with invalid bits/unsigned metadata", () => {
        const invalidTypes = [
            { kind: "integer", bits: 7 },
            { kind: "integer", bits: 128 },
            { kind: "number", bits: 8 },   // 8/16 are not valid float widths
            { kind: "number", bits: 16 },
            { kind: "integer", unsigned: "yes" },
        ];
        for (const type of invalidTypes) {
            const doc = {
                ...goldenIR,
                schemas: [{ ...minimalSchema, fields: [{ ...minimalField, type }] }],
            };
            assert.equal(validateIR(doc).valid, false, `Expected invalid for ${JSON.stringify(type)}`);
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

    it("accepts array types, with and without nullable elements", () => {
        const array = { kind: "array", of: { kind: "number" } };
        const nullableElems = { kind: "array", of: { kind: "number" }, elementNullable: true };
        for (const type of [array, nullableElems]) {
            const doc = {
                ...goldenIR,
                schemas: [{ ...minimalSchema, fields: [{ ...minimalField, type }] }],
            };
            assert.equal(validateIR(doc).valid, true);
        }
    });

    it("accepts a field-level nullable flag", () => {
        const doc = {
            ...goldenIR,
            schemas: [{ ...minimalSchema, fields: [{ ...minimalField, nullable: true }] }],
        };
        assert.equal(validateIR(doc).valid, true);
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

    it("rejects an unknown intrinsic op in a getter behavior", () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                methods: [{
                    name: "bad", kind: "getter", params: [] as unknown[], returnType: { kind: "string" },
                    statements: [{ kind: "return", value: { kind: "intrinsic", op: "string.bogus", receiver: { kind: "field", name: "x" }, args: [] } }],
                    visibility: "public", source: minimalSource,
                }],
            }],
        };
        const result = validateIR(doc);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some((e) => e.message.includes("unknown intrinsic op")));
    });

    it("accepts a known intrinsic op in a getter behavior", () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                methods: [{
                    name: "good", kind: "getter", params: [] as unknown[], returnType: { kind: "integer" },
                    statements: [{ kind: "return", value: { kind: "intrinsic", op: "array.length", receiver: { kind: "field", name: "x" }, args: [] } }],
                    visibility: "public", source: minimalSource,
                }],
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it('accepts a "text" direction on a field index but rejects a bad one', () => {
        const ok = {
            ...goldenIR,
            schemas: [{ ...minimalSchema, fields: [{ ...minimalField, extensions: { schema: { indexes: [{ direction: "text" }] } } }] }],
        };
        assert.equal(validateIR(ok).valid, true);

        const bad = {
            ...goldenIR,
            schemas: [{ ...minimalSchema, fields: [{ ...minimalField, extensions: { schema: { indexes: [{ direction: 5 }] } } }] }],
        };
        assert.equal(validateIR(bad).valid, false);
    });

    it('accepts a "text" direction on a composite index', () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                extensions: { schema: { indexes: [{ fields: [{ name: "x", direction: "text" }] }] } },
            }],
        };
        assert.equal(validateIR(doc).valid, true);
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
                extensions: { schema: { indexes: [{ fields: [{ name: "email", direction: 1 }, { name: "createdAt", direction: -1 }], unique: true }] } },
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("accepts a getter behavior with a portable expression body", () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                methods: [{
                    name: "fullName", kind: "getter", params: [] as unknown[], returnType: { kind: "string" },
                    statements: [{
                        kind: "return",
                        value: {
                            kind: "template",
                            parts: [
                                { kind: "field", name: "firstName" },
                                { kind: "literal", value: " " },
                                { kind: "field", name: "lastName" },
                            ],
                        },
                    }],
                    visibility: "public", source: minimalSource,
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

describe("validateIR — intrinsics & declarations", () => {
    const validatorDecl = {
        name: "v",
        factoryParams: [] as unknown[],
        inputType: { kind: "string" as const },
        body: {
            params: [{ name: "value", role: "value" as const }],
            statements: [{
                kind: "return" as const,
                value: {
                    kind: "intrinsic" as const, op: "string.includes",
                    receiver: { kind: "field" as const, name: "value" },
                    args: [{ kind: "literal" as const, value: "x" }],
                },
            }],
        },
        source: minimalSource,
    };

    it("accepts an intrinsic expression node", () => {
        const doc = { ...goldenIR, validatorDeclarations: [validatorDecl] };
        const result = validateIR(doc);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it("rejects an intrinsic with a missing op", () => {
        const bad = structuredClone(validatorDecl);
        (bad.body.statements[0] as any).value.op = "";
        const doc = { ...goldenIR, validatorDeclarations: [bad] };
        assert.equal(validateIR(doc).valid, false);
    });

    // ── Arrow node: exactly one of body|statements, optional returnType ──────────
    const arrowValidator = (arrow: unknown) => ({
        name: "v",
        factoryParams: [] as unknown[],
        inputType: { kind: "array" as const, of: { kind: "string" as const } },
        body: {
            params: [{ name: "value", role: "value" as const }],
            statements: [{
                kind: "return" as const,
                value: { kind: "intrinsic" as const, op: "array.filter", receiver: { kind: "field" as const, name: "value" }, args: [arrow] },
            }],
        },
        source: minimalSource,
    });
    const validateArrow = (arrow: unknown) => validateIR({ ...goldenIR, validatorDeclarations: [arrowValidator(arrow)] });

    it("accepts a concise-body arrow", () => {
        const r = validateArrow({ kind: "arrow", params: ["x"], body: { kind: "binary", op: ">", left: { kind: "identifier", name: "x" }, right: { kind: "literal", value: 0 } } });
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("accepts a block-body arrow (statements + returnType)", () => {
        const r = validateArrow({ kind: "arrow", params: ["x"], statements: [{ kind: "return", value: { kind: "identifier", name: "x" } }], returnType: { kind: "boolean" } });
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("rejects an arrow with BOTH body and statements", () => {
        const r = validateArrow({ kind: "arrow", params: ["x"], body: { kind: "identifier", name: "x" }, statements: [{ kind: "return", value: { kind: "identifier", name: "x" } }] });
        assert.equal(r.valid, false);
    });

    it("rejects an arrow with NEITHER body nor statements", () => {
        const r = validateArrow({ kind: "arrow", params: ["x"] });
        assert.equal(r.valid, false);
    });

    it("rejects an arrow with an invalid returnType", () => {
        const r = validateArrow({ kind: "arrow", params: ["x"], body: { kind: "identifier", name: "x" }, returnType: { kind: "bogus" } });
        assert.equal(r.valid, false);
    });

    it("requires inputType on a validator declaration", () => {
        const bad = structuredClone(validatorDecl) as any;
        delete bad.inputType;
        const doc = { ...goldenIR, validatorDeclarations: [bad] };
        const result = validateIR(doc);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some(e => e.path.includes("inputType")));
    });

    it("accepts functionDeclarations", () => {
        const doc = {
            ...goldenIR,
            functionDeclarations: [{
                name: "isLong",
                params: [{ name: "s", type: { kind: "string" } }],
                returnType: { kind: "boolean" },
                statements: [{
                    kind: "return",
                    value: {
                        kind: "binary", op: ">",
                        left: { kind: "intrinsic", op: "string.length", receiver: { kind: "identifier", name: "s" }, args: [] },
                        right: { kind: "literal", value: 3 },
                    },
                }],
                source: minimalSource,
            }],
        };
        const result = validateIR(doc);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it("rejects a functionDeclaration with a bad param type", () => {
        const doc = {
            ...goldenIR,
            functionDeclarations: [{
                name: "f",
                params: [{ name: "s", type: { kind: "nope" } }],
                returnType: { kind: "boolean" },
                statements: [],
                source: minimalSource,
            }],
        };
        assert.equal(validateIR(doc).valid, false);
    });

    it("accepts a schema with method and setter behaviors (incl. assign statement)", () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                fields: [minimalField, { ...minimalField, name: "email", type: { kind: "string" } }],
                methods: [
                    {
                        name: "greeting",
                        kind: "method",
                        params: [{ name: "prefix", type: { kind: "string" } }],
                        returnType: { kind: "string" },
                        statements: [{ kind: "return", value: { kind: "field", name: "email" } }],
                        visibility: "public",
                        source: minimalSource,
                    },
                    {
                        name: "primaryEmail",
                        kind: "setter",
                        params: [{ name: "value", type: { kind: "string" } }],
                        statements: [{
                            kind: "assign",
                            target: { kind: "field", name: "email" },
                            value: { kind: "identifier", name: "value" },
                        }],
                        visibility: "public",
                        source: minimalSource,
                    },
                ],
            }],
        };
        const result = validateIR(doc);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it("rejects a method with an invalid kind", () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                methods: [{
                    name: "m",
                    kind: "lambda",
                    params: [],
                    statements: [],
                    visibility: "public",
                    source: minimalSource,
                }],
            }],
        };
        const result = validateIR(doc);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some((e) => e.path.includes("methods[0].kind")));
    });

    it("rejects an assign statement with a malformed target", () => {
        const doc = {
            ...goldenIR,
            schemas: [{
                ...minimalSchema,
                methods: [{
                    name: "s",
                    kind: "setter",
                    params: [{ name: "v", type: { kind: "string" } }],
                    statements: [{ kind: "assign", target: { kind: "field" }, value: { kind: "literal", value: 1 } }],
                    visibility: "public",
                    source: minimalSource,
                }],
            }],
        };
        assert.equal(validateIR(doc).valid, false);
    });

    it("accepts services with method contracts (signatures only)", () => {
        const doc = {
            ...goldenIR,
            services: [{
                id: "service:Greeter",
                name: "Greeter",
                sourceName: "Greeter",
                visibility: "public",
                methods: [
                    {
                        name: "greet",
                        params: [{ name: "input", type: { kind: "reference", schema: "In" } }],
                        returnType: { kind: "reference", schema: "Out" },
                        visibility: "public",
                        source: minimalSource,
                    },
                    { name: "ping", params: [], visibility: "private", source: minimalSource },
                ],
                source: minimalSource,
            }],
        };
        const result = validateIR(doc);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it("rejects a service method with a malformed param type (right path)", () => {
        const doc = {
            ...goldenIR,
            services: [{
                id: "service:S",
                name: "S",
                sourceName: "S",
                visibility: "public",
                methods: [{
                    name: "m",
                    params: [{ name: "p", type: { kind: "nope" } }],
                    visibility: "public",
                    source: minimalSource,
                }],
                source: minimalSource,
            }],
        };
        const result = validateIR(doc);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some((e) => e.path.includes("services[0].methods[0].params[0].type")));
    });

    it("rejects a service method missing visibility", () => {
        const doc = {
            ...goldenIR,
            services: [{
                id: "service:S",
                name: "S",
                sourceName: "S",
                visibility: "public",
                methods: [{ name: "m", params: [], source: minimalSource }],
                source: minimalSource,
            }],
        };
        assert.equal(validateIR(doc).valid, false);
    });
});

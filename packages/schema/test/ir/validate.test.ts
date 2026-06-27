import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateIR, defaultIRValidators } from "@keyma/core/ir";
import { schemaIRValidator } from "../../src/ir/index.js";

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
    source: minimalSource,
};

/** Wrap validator/formatter attachments in the field's `extensions['schema']` slice. */
const fieldExt = (slice: Record<string, unknown>) => ({ ...minimalField, extensions: { schema: slice } });

const minimalSchema = {
    name: "user",
    sourceName: "User",
    visibility: "public" as const,
    fields: [minimalField],
    source: minimalSource,
};

const goldenIR = {
    irVersion: "1.0.0",
    compilerVersion: "0.1.0",
    classes: [minimalSchema],
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
        const doc = { ...goldenIR, classes: "nope" };
        const result = validateIR(doc);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some(e => e.path === "classes"));
    });

    it("accepts an ephemeral schema and an ephemeral field", () => {
        const doc = {
            ...goldenIR,
            classes: [
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
            classes: [{ ...minimalSchema, visibility: "maybe" }],
        };
        const result = validateIR(doc);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some(e => e.path.includes("visibility")));
    });

    it("rejects invalid field type kind", () => {
        const doc = {
            ...goldenIR,
            classes: [{
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
                classes: [{
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
                classes: [{ ...minimalSchema, fields: [{ ...minimalField, type }] }],
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
                classes: [{ ...minimalSchema, fields: [{ ...minimalField, type }] }],
            };
            assert.equal(validateIR(doc).valid, false, `Expected invalid for ${JSON.stringify(type)}`);
        }
    });

    it("accepts enum type with values", () => {
        const doc = {
            ...goldenIR,
            classes: [{
                ...minimalSchema,
                fields: [{ ...minimalField, type: { kind: "enum", values: ["draft", "published"] } }],
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("rejects enum type with empty values", () => {
        const doc = {
            ...goldenIR,
            classes: [{
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
                classes: [{ ...minimalSchema, fields: [{ ...minimalField, type }] }],
            };
            assert.equal(validateIR(doc).valid, true);
        }
    });

    it("accepts a field-level nullable flag", () => {
        const doc = {
            ...goldenIR,
            classes: [{ ...minimalSchema, fields: [{ ...minimalField, nullable: true }] }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("accepts reference and embedded types", () => {
        for (const kind of ["reference", "embedded"]) {
            const doc = {
                ...goldenIR,
                classes: [{
                    ...minimalSchema,
                    fields: [{ ...minimalField, type: { kind, target: "Address" } }],
                }],
            };
            assert.equal(validateIR(doc).valid, true);
        }
    });

    it("rejects an unknown intrinsic op in a getter behavior", () => {
        const doc = {
            ...goldenIR,
            classes: [{
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
            classes: [{
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
            classes: [{ ...minimalSchema, fields: [{ ...minimalField, extensions: { schema: { indexes: [{ direction: "text" }] } } }] }],
        };
        assert.equal(validateIR(ok).valid, true);

        const bad = {
            ...goldenIR,
            classes: [{ ...minimalSchema, fields: [{ ...minimalField, extensions: { schema: { indexes: [{ direction: 5 }] } } }] }],
        };
        assert.equal(validateIR(bad).valid, false);
    });

    it('accepts a "text" direction on a composite index', () => {
        const doc = {
            ...goldenIR,
            classes: [{
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
            classes: [{
                ...minimalSchema,
                fields: [fieldExt({ validators: scalarValidators })],
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
            classes: [{
                ...minimalSchema,
                fields: [fieldExt({ validators: numericValidators })],
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("rejects unknown validator kind", () => {
        const doc = {
            ...goldenIR,
            classes: [{
                ...minimalSchema,
                // A validator attachment references a factory by `name`; one without a name is malformed.
                fields: [fieldExt({ validators: [{ kind: "madeUp" }] })],
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
            classes: [{
                ...minimalSchema,
                fields: [fieldExt({ formatters })],
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("rejects invalid formatter phase", () => {
        const doc = {
            ...goldenIR,
            classes: [{
                ...minimalSchema,
                fields: [fieldExt({ formatters: [{ phase: "midnight", spec: { name: "trim" } }] })],
            }],
        };
        assert.equal(validateIR(doc).valid, false);
    });

    it("accepts truncate formatter with maxLength", () => {
        const doc = {
            ...goldenIR,
            classes: [{
                ...minimalSchema,
                fields: [fieldExt({ formatters: [{ phase: "save", spec: { name: "truncate", params: { maxLength: 50 } } }] })],
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("accepts composite index", () => {
        const doc = {
            ...goldenIR,
            classes: [{
                ...minimalSchema,
                extensions: { schema: { indexes: [{ fields: [{ name: "email", direction: 1 }, { name: "createdAt", direction: -1 }], unique: true }] } },
            }],
        };
        assert.equal(validateIR(doc).valid, true);
    });

    it("accepts a getter behavior with a portable expression body", () => {
        const doc = {
            ...goldenIR,
            classes: [{
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
    // A collapsed validator/formatter factory is an ordinary `IRFunctionDeclaration` whose
    // body returns an intrinsic/arrow — exercises the portable expression/statement checks
    // reachable from `functionDeclarations`.
    const validatorFn = {
        name: "v",
        params: [] as unknown[],
        returnType: { kind: "json" as const },
        statements: [{
            kind: "return" as const,
            value: {
                kind: "intrinsic" as const, op: "string.includes",
                receiver: { kind: "field" as const, name: "value" },
                args: [{ kind: "literal" as const, value: "x" }],
            },
        }],
        source: minimalSource,
    };

    it("accepts an intrinsic expression node", () => {
        const doc = { ...goldenIR, functionDeclarations: [validatorFn] };
        const result = validateIR(doc);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    it("rejects an intrinsic with a missing op", () => {
        const bad = structuredClone(validatorFn);
        (bad.statements[0] as any).value.op = "";
        const doc = { ...goldenIR, functionDeclarations: [bad] };
        assert.equal(validateIR(doc).valid, false);
    });

    // ── Arrow node: exactly one of body|statements, optional returnType ──────────
    const arrowFn = (arrow: unknown) => ({
        name: "v",
        params: [] as unknown[],
        returnType: { kind: "json" as const },
        statements: [{
            kind: "return" as const,
            value: { kind: "intrinsic" as const, op: "array.filter", receiver: { kind: "field" as const, name: "value" }, args: [arrow] },
        }],
        source: minimalSource,
    });
    const validateArrow = (arrow: unknown) => validateIR({ ...goldenIR, functionDeclarations: [arrowFn(arrow)] });

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
            classes: [{
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
            classes: [{
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
            classes: [{
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
                        params: [{ name: "input", type: { kind: "reference", target: "In" } }],
                        returnType: { kind: "reference", target: "Out" },
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

// ─── Additive IR vocabulary (issue #001) ────────────────────────────────────────
// The prefactor adds new node kinds/flags the later semantic slices consume. Validation
// must ACCEPT the new shapes (and still reject malformed ones); nothing produces them yet.
describe("validateIR — additive IR vocabulary", () => {
    // Drive core checkType through a function declaration's param/return positions, and
    // core checkStatement/checkExpression through its statement body.
    const fnDecl = (over: Record<string, unknown>) => ({
        ...goldenIR,
        functionDeclarations: [{
            name: "f",
            params: [{ name: "x", type: { kind: "string" } }],
            returnType: { kind: "boolean" },
            statements: [],
            source: minimalSource,
            ...over,
        }],
    });

    it("accepts the `instance` type in a param/return position", () => {
        const r = validateIR(fnDecl({
            params: [{ name: "u", type: { kind: "instance", name: "User" } }],
            returnType: { kind: "instance", name: "User" },
        }));
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("rejects an `instance` type with an empty name", () => {
        const r = validateIR(fnDecl({ returnType: { kind: "instance", name: "" } }));
        assert.equal(r.valid, false);
    });

    it("accepts the `function` (HOF) type with typed params and a return", () => {
        const r = validateIR(fnDecl({
            params: [{ name: "cb", type: { kind: "function", params: [{ name: "v", type: { kind: "string" } }], returns: { kind: "boolean" } } }],
        }));
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("accepts a `function` type with no `returns` (void)", () => {
        const r = validateIR(fnDecl({
            params: [{ name: "cb", type: { kind: "function", params: [] } }],
        }));
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("rejects a `function` type with a bad param type", () => {
        const r = validateIR(fnDecl({
            params: [{ name: "cb", type: { kind: "function", params: [{ name: "v", type: { kind: "nope" } }] } }],
        }));
        assert.equal(r.valid, false);
    });

    it("accepts typed arrow params (name + type + optional)", () => {
        const r = validateIR(fnDecl({
            statements: [{ kind: "expression", expr: { kind: "arrow", params: [{ name: "v", type: { kind: "string" }, optional: true }, "rest"], body: { kind: "identifier", name: "v" } } }],
        }));
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("rejects a typed arrow param with a bad type", () => {
        const r = validateIR(fnDecl({
            statements: [{ kind: "expression", expr: { kind: "arrow", params: [{ name: "v", type: { kind: "nope" } }], body: { kind: "identifier", name: "v" } } }],
        }));
        assert.equal(r.valid, false);
    });

    it("accepts an `await` expression", () => {
        const r = validateIR(fnDecl({
            statements: [{ kind: "expression", expr: { kind: "await", operand: { kind: "identifier", name: "p" } } }],
        }));
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("accepts forOf / while / break / continue statements", () => {
        const r = validateIR(fnDecl({
            statements: [
                { kind: "forOf", name: "x", iterable: { kind: "identifier", name: "xs" }, body: [{ kind: "break" }] },
                { kind: "while", condition: { kind: "literal", value: true }, body: [{ kind: "continue" }] },
            ],
        }));
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("rejects a forOf with an empty loop-variable name", () => {
        const r = validateIR(fnDecl({
            statements: [{ kind: "forOf", name: "", iterable: { kind: "identifier", name: "xs" }, body: [] }],
        }));
        assert.equal(r.valid, false);
    });

    it("accepts a switch with a case (fallthrough) and a default arm", () => {
        const r = validateIR(fnDecl({
            statements: [{
                kind: "switch",
                discriminant: { kind: "identifier", name: "d" },
                cases: [
                    { test: { kind: "literal", value: "a" }, body: [{ kind: "break" }] },
                    { test: { kind: "literal", value: "b" }, body: [] },
                    { test: null, body: [{ kind: "break" }] },
                ],
            }],
        }));
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("rejects a switch case missing `test`", () => {
        const r = validateIR(fnDecl({
            statements: [{ kind: "switch", discriminant: { kind: "identifier", name: "d" }, cases: [{ body: [] }] }],
        }));
        assert.equal(r.valid, false);
    });

    it("accepts the `async` flag on a function declaration", () => {
        const r = validateIR(fnDecl({ async: true }));
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("rejects a non-boolean `async` flag on a function declaration", () => {
        const r = validateIR(fnDecl({ async: "yes" }));
        assert.equal(r.valid, false);
    });

    it("accepts constructor / destructor methods and an async method", () => {
        const doc = {
            ...goldenIR,
            classes: [{
                ...minimalSchema,
                methods: [
                    { name: "constructor", kind: "constructor", params: [{ name: "v", type: { kind: "string" } }], statements: [], visibility: "public", source: minimalSource },
                    { name: "destructor", kind: "destructor", params: [], statements: [], visibility: "public", source: minimalSource },
                    { name: "load", kind: "method", async: true, params: [], returnType: { kind: "instance", name: "user" }, statements: [{ kind: "return", value: { kind: "literal", value: null } }], visibility: "public", source: minimalSource },
                ],
            }],
        };
        const r = validateIR(doc);
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("rejects an unknown method kind", () => {
        const doc = {
            ...goldenIR,
            classes: [{
                ...minimalSchema,
                methods: [{ name: "m", kind: "finalizer", params: [], statements: [], visibility: "public", source: minimalSource }],
            }],
        };
        assert.equal(validateIR(doc).valid, false);
    });
});

// ─── Eliminate-domain-backends Step 1: function-as-value vocabulary ──────────────
// external / typeVar types, generic typeParams + the unbound-typeVar invariant, typeArgs
// bindings on function-value references, and audience-gated method bodies. Validation must
// ACCEPT the new shapes and reject malformed ones; nothing emits them yet.
describe("validateIR — function-as-value vocabulary (eliminate-domain-backends step 1)", () => {
    const fnDecl = (over: Record<string, unknown>) => ({
        ...goldenIR,
        functionDeclarations: [{
            name: "f",
            params: [{ name: "x", type: { kind: "string" } }],
            returnType: { kind: "boolean" },
            statements: [],
            source: minimalSource,
            ...over,
        }],
    });

    // ── external type ──────────────────────────────────────────────────────────
    it("accepts the `external` type in param/return positions", () => {
        const r = validateIR(fnDecl({
            params: [{ name: "e", type: { kind: "external", name: "ValidationError" } }],
            returnType: { kind: "external", name: "ValidatorFn" },
        }));
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("rejects an `external` type with an empty name", () => {
        const r = validateIR(fnDecl({ returnType: { kind: "external", name: "" } }));
        assert.equal(r.valid, false);
    });

    // ── typeParams + typeVar (bound/unbound invariant) ───────────────────────────
    it("accepts a generic function: typeVar bound by typeParams", () => {
        const r = validateIR(fnDecl({
            typeParams: ["T"],
            params: [{ name: "v", type: { kind: "typeVar", name: "T" } }],
            returnType: { kind: "function", params: [{ name: "x", type: { kind: "typeVar", name: "T" } }], returns: { kind: "json" } },
        }));
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("rejects an unbound typeVar (referenced but not declared in typeParams)", () => {
        const r = validateIR(fnDecl({
            params: [{ name: "v", type: { kind: "typeVar", name: "T" } }],
        }));
        assert.equal(r.valid, false);
        assert.ok(r.errors.some((e) => e.message.includes("unbound type variable")), JSON.stringify(r.errors));
    });

    it("rejects a typeVar with an empty name", () => {
        const r = validateIR(fnDecl({ typeParams: ["T"], returnType: { kind: "typeVar", name: "" } }));
        assert.equal(r.valid, false);
    });

    it("rejects duplicate typeParams", () => {
        const r = validateIR(fnDecl({ typeParams: ["T", "T"] }));
        assert.equal(r.valid, false);
    });

    it("rejects a non-string typeParam", () => {
        const r = validateIR(fnDecl({ typeParams: [42] }));
        assert.equal(r.valid, false);
    });

    it("flags a typeVar buried in the body as unbound", () => {
        const r = validateIR(fnDecl({
            statements: [{ kind: "expression", expr: { kind: "arrow", params: [{ name: "v", type: { kind: "typeVar", name: "U" } }], body: { kind: "identifier", name: "v" } } }],
        }));
        assert.equal(r.valid, false);
        assert.ok(r.errors.some((e) => e.message.includes("unbound type variable")), JSON.stringify(r.errors));
    });

    // ── typeArgs on function-value references (call / identifier) ─────────────────
    it("accepts typeArgs on a call expression (generic factory binding)", () => {
        const r = validateIR(fnDecl({
            statements: [{ kind: "expression", expr: { kind: "call", callee: { kind: "identifier", name: "minLength" }, args: [{ kind: "literal", value: 2 }], typeArgs: { T: { kind: "string" } } } }],
        }));
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("accepts typeArgs on an identifier (generic function-value reference)", () => {
        const r = validateIR(fnDecl({
            statements: [{ kind: "expression", expr: { kind: "identifier", name: "required", typeArgs: { T: { kind: "id" } } } }],
        }));
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("rejects typeArgs whose bound value is an invalid type", () => {
        const r = validateIR(fnDecl({
            statements: [{ kind: "expression", expr: { kind: "call", callee: { kind: "identifier", name: "f" }, args: [], typeArgs: { T: { kind: "nope" } } } }],
        }));
        assert.equal(r.valid, false);
    });

    it("rejects non-object typeArgs", () => {
        const r = validateIR(fnDecl({
            statements: [{ kind: "expression", expr: { kind: "identifier", name: "f", typeArgs: "T=string" } }],
        }));
        assert.equal(r.valid, false);
    });

    // ── bodyAudience on methods ──────────────────────────────────────────────────
    const methodDoc = (over: Record<string, unknown>) => ({
        ...goldenIR,
        classes: [{
            ...minimalSchema,
            fields: [minimalField, { ...minimalField, name: "value", type: { kind: "string" } }],
            methods: [{
                name: "formatSave", kind: "method",
                params: [{ name: "value", type: { kind: "string" } }],
                returnType: { kind: "string" },
                statements: [{ kind: "return", value: { kind: "identifier", name: "value" } }],
                visibility: "public", source: minimalSource,
                ...over,
            }],
        }],
    });

    it("accepts a method with a well-formed bodyAudience (server real body, client fallback)", () => {
        const r = validateIR(methodDoc({
            bodyAudience: { audiences: ["server", "library"], fallback: [{ kind: "return", value: { kind: "identifier", name: "value" } }] },
        }));
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    it("rejects bodyAudience with empty audiences", () => {
        const r = validateIR(methodDoc({ bodyAudience: { audiences: [], fallback: [] } }));
        assert.equal(r.valid, false);
    });

    it("rejects bodyAudience with an unknown audience (e.g. client)", () => {
        const r = validateIR(methodDoc({ bodyAudience: { audiences: ["client"], fallback: [] } }));
        assert.equal(r.valid, false);
    });

    it("rejects bodyAudience whose fallback is not an array", () => {
        const r = validateIR(methodDoc({ bodyAudience: { audiences: ["server"], fallback: "noop" } }));
        assert.equal(r.valid, false);
    });

    it("rejects bodyAudience with a malformed fallback statement", () => {
        const r = validateIR(methodDoc({ bodyAudience: { audiences: ["server"], fallback: [{ kind: "bogus" }] } }));
        assert.equal(r.valid, false);
    });
});

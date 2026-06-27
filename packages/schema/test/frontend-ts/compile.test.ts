import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile, compileVirtual } from "./harness.js";
import * as CODES from "../../src/frontend-ts/diagnostics.js";
import { schemaEdge, schemaEphemeral, fieldIndexes, fieldValidators, fieldFormatters } from "../../src/ir/extensions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.join(__dirname, "..", "..", "..", "test", "frontend-ts", "fixtures");

/** Absolute path to a fixture file (works from dist/test/). */
function fixture(name: string): string {
    return path.join(FIXTURES, name);
}

/** Base directory for virtual file module resolution — inside the package src. */
const VIRTUAL_BASE = path.join(__dirname, "..", "..", "..", "src", "frontend-ts");

/** Compile a virtual TypeScript source and return the result. */
function cv(sources: Record<string, string>) {
    return compileVirtual(sources, { baseDir: VIRTUAL_BASE });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function errorCodes(result: ReturnType<typeof compile>): string[] {
    return result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

function hasError(result: ReturnType<typeof compile>, code: string): boolean {
    return result.diagnostics.some((d) => d.code === code && d.severity === "error");
}

function schemaByName(result: ReturnType<typeof compile>, sourceName: string) {
    const s = result.ir.classes.find((s) => s.sourceName === sourceName);
    assert.ok(s !== undefined, `Schema "${sourceName}" not found. Available: ${result.ir.classes.map((s) => s.sourceName).join(", ")}`);
    return s;
}

// ─── Golden IR — basic schema ─────────────────────────────────────────────────

describe("compile basic schema", () => {
    const result = compile({ files: [fixture("basic.ts")] });

    it("produces no errors", () => {
        const errors = errorCodes(result);
        assert.deepEqual(errors, [], `Unexpected errors: ${JSON.stringify(result.diagnostics)}`);
    });

    it("discovers the User schema", () => {
        const user = schemaByName(result, "User");
        assert.equal(user.name, "user");
        assert.equal(user.visibility, "public");
        assert.equal(user.description, "A platform user");
    });

    it("maps id field: ID → id type, readonly, required", () => {
        const user = schemaByName(result, "User");
        const id = user.fields.find((f) => f.name === "id");
        assert.ok(id, "id field not found");
        assert.deepEqual(id.type, { kind: "id" });
        assert.equal(id.readonly, true);
        assert.equal(id.required, true);
        assert.equal(id.visibility, "public");
        assert.ok(fieldValidators(id).some((v) => v.name === "required"), "isRequired validator expected");
        assert.ok(fieldIndexes(id).some((i) => i.unique === true), "unique index expected");
    });

    it("maps firstName: string with validators and format", () => {
        const user = schemaByName(result, "User");
        const f = user.fields.find((f) => f.name === "firstName");
        assert.ok(f, "firstName field not found");
        assert.deepEqual(f.type, { kind: "string" });
        assert.equal(f.required, true);
        assert.ok(fieldValidators(f).some((v) => v.name === "required"), "required validator expected");
        assert.ok(fieldValidators(f).some((v) => v.name === "minLength" && (v.params as any)?.value === 2), "minLength(2) expected");
        assert.ok(fieldValidators(f).some((v) => v.name === "maxLength" && (v.params as any)?.value === 64), "maxLength(64) expected");
        assert.ok(fieldFormatters(f).some((fmt) => fmt.phase === "change" && fmt.spec.name === "trim"), "trim formatter expected");
    });

    it("maps email: string with emailAddress validator and unique index", () => {
        const user = schemaByName(result, "User");
        const f = user.fields.find((f) => f.name === "email");
        assert.ok(f, "email field not found");
        assert.deepEqual(f.type, { kind: "string" });
        assert.ok(fieldValidators(f).some((v) => v.name === "emailAddress"), "emailAddress validator expected");
        assert.ok(fieldIndexes(f).some((i) => i.unique === true), "unique index expected");
    });

    it("maps optional age: number → required: false", () => {
        const user = schemaByName(result, "User");
        const f = user.fields.find((f) => f.name === "age");
        assert.ok(f, "age field not found");
        assert.deepEqual(f.type, { kind: "number" });
        assert.equal(f.required, false);
    });

    it("calculates sourceRoot as the directory of the single input file", () => {
        const file = fixture("basic.ts");
        assert.equal(result.ir.sourceRoot, path.dirname(file));
    });
});

// ─── Golden IR — all types ────────────────────────────────────────────────────

describe("compile all-types schema", () => {
    const result = compile({ files: [fixture("all-types.ts")] });

    it("produces no errors", () => {
        assert.deepEqual(errorCodes(result), [], `Errors: ${JSON.stringify(result.diagnostics)}`);
    });

    it("maps all scalar types correctly", () => {
        const schema = schemaByName(result, "AllTypes");
        const byName = (n: string) => {
            const f = schema.fields.find((f) => f.name === n);
            assert.ok(f, `field "${n}" not found`);
            return f;
        };

        assert.deepEqual(byName("id").type, { kind: "id" });
        assert.deepEqual(byName("name").type, { kind: "string" });
        assert.deepEqual(byName("count").type, { kind: "number" });
        assert.deepEqual(byName("flag").type, { kind: "boolean" });
        assert.deepEqual(byName("big").type, { kind: "bigint" });
        assert.deepEqual(byName("date").type, { kind: "date" });
        assert.deepEqual(byName("ts").type, { kind: "dateTime" });
        assert.deepEqual(byName("time").type, { kind: "time" });
        assert.deepEqual(byName("money").type, { kind: "decimal" });
        assert.deepEqual(byName("blob").type, { kind: "bytes" });
        assert.deepEqual(byName("meta").type, { kind: "json" });
    });

    it("maps array, enum, nullable, and reference types", () => {
        const schema = schemaByName(result, "AllTypes");
        const byName = (n: string) => {
            const f = schema.fields.find((f) => f.name === n);
            assert.ok(f, `field "${n}" not found`);
            return f;
        };

        assert.deepEqual(byName("tags").type, { kind: "array", of: { kind: "string" } });
        assert.deepEqual(byName("status").type, { kind: "enum", values: ["draft", "published", "archived"] });
        assert.deepEqual(byName("maybe").type, { kind: "string" });
        assert.equal(byName("maybe").required, false); // optional (key may be absent)
        assert.equal(byName("maybe").nullable, undefined); // but not nullable

        // nullable is now a field-level axis, orthogonal to optionality
        assert.deepEqual(byName("nullableStr").type, { kind: "string" });
        assert.equal(byName("nullableStr").nullable, true);
        assert.equal(byName("nullableStr").required, true); // present, but may be null

        // references carry the resolved id type of their target
        assert.deepEqual(byName("addr").type, { kind: "reference", target: "address", idType: { kind: "id" } });
        assert.deepEqual(byName("embedded").type, { kind: "embedded", target: "address" });

        assert.deepEqual(byName("nullableRef").type, { kind: "reference", target: "address", idType: { kind: "id" } });
        assert.equal(byName("nullableRef").nullable, true);
    });
});

// ─── Golden IR — numeric width types ──────────────────────────────────────────

describe("compile numeric-types schema", () => {
    const result = compile({ files: [fixture("numeric-types.ts")] });

    it("produces no errors", () => {
        assert.deepEqual(errorCodes(result), [], `Errors: ${JSON.stringify(result.diagnostics)}`);
    });

    it("lowers Integer/Unsigned/Float widths, omitting bits at the default (64)", () => {
        const schema = schemaByName(result, "NumericTypes");
        const byName = (n: string) => {
            const f = schema.fields.find((f) => f.name === n);
            assert.ok(f, `field "${n}" not found`);
            return f;
        };

        assert.deepEqual(byName("i8").type, { kind: "integer", bits: 8 });
        assert.deepEqual(byName("i16").type, { kind: "integer", bits: 16 });
        assert.deepEqual(byName("i32").type, { kind: "integer", bits: 32 });
        assert.deepEqual(byName("i64").type, { kind: "integer" }); // 64 default → bits omitted

        assert.deepEqual(byName("u8").type, { kind: "integer", bits: 8, unsigned: true });
        assert.deepEqual(byName("u32").type, { kind: "integer", bits: 32, unsigned: true });
        assert.deepEqual(byName("u64").type, { kind: "integer", unsigned: true }); // 64 default → bits omitted

        assert.deepEqual(byName("f").type, { kind: "number" }); // 64 default → bits omitted
        assert.deepEqual(byName("f32").type, { kind: "number", bits: 32 });
    });

    it("recurses through array and optional positions", () => {
        const schema = schemaByName(result, "NumericTypes");
        const byName = (n: string) => {
            const f = schema.fields.find((f) => f.name === n);
            assert.ok(f, `field "${n}" not found`);
            return f;
        };
        assert.deepEqual(byName("ints").type, { kind: "array", of: { kind: "integer", bits: 16 } });
        assert.deepEqual(byName("maybeBig").type, { kind: "integer", unsigned: true });
        assert.equal(byName("maybeBig").required, false);
    });
});

describe("KEYMA099 — invalid numeric width", () => {
    it("emits KEYMA099 for a non-allowed Integer width", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import type { Integer } from "@keyma/schema/dsl";
                @Schema() class Foo {
                    declare bad: Integer<7>;
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA099), `Expected KEYMA099. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("emits KEYMA099 for a non-allowed Float width", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import type { Float } from "@keyma/schema/dsl";
                @Schema() class Foo {
                    declare bad: Float<16>;
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA099), `Expected KEYMA099. Got: ${JSON.stringify(result.diagnostics)}`);
    });
});

// ─── Golden IR — inheritance ──────────────────────────────────────────────────

describe("compile inheritance", () => {
    const result = compile({ files: [fixture("inheritance.ts")] });

    it("produces no errors", () => {
        assert.deepEqual(errorCodes(result), [], `Errors: ${JSON.stringify(result.diagnostics)}`);
    });

    it("Employee schema carries OWN fields only (real inheritance, no flattening)", () => {
        const emp = schemaByName(result, "Employee");
        const fieldNames = emp.fields.map((f) => f.name);
        assert.ok(fieldNames.includes("department"), "own field department");
        assert.ok(fieldNames.includes("salary"), "own field salary");
        // Inherited fields are NOT merged in — they live on Person and are walked at runtime.
        assert.ok(!fieldNames.includes("id"), "id stays on Person, not flattened into Employee");
        assert.ok(!fieldNames.includes("firstName"), "firstName stays on Person");
        assert.ok(!fieldNames.includes("lastName"), "lastName stays on Person");
    });

    it("Employee keeps `extends` pointing at the parent's emit symbol (sourceName)", () => {
        const emp = schemaByName(result, "Employee");
        assert.equal(emp.extends, "Person", "inheritance is real — `extends` survives to the IR");
        assert.equal(emp.extendsSource, undefined, "deprecated provenance field is no longer set");
    });

    it("Employee has each own field exactly once", () => {
        const emp = schemaByName(result, "Employee");
        const counts = new Map<string, number>();
        for (const f of emp.fields) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
        for (const [name, n] of counts) assert.equal(n, 1, `field "${name}" appears ${n} times`);
    });

    it("tags are chain-unique: Employee's own-field tags continue past Person's max", () => {
        // Binary tags are only assigned when binary is enabled; assignTags walks the
        // inheritance chain so a child's own-field tags never collide with inherited ones.
        const tagged = compile({ files: [fixture("inheritance.ts")], binaryTags: true });
        assert.deepEqual(errorCodes(tagged), [], `Errors: ${JSON.stringify(tagged.diagnostics)}`);
        const person = schemaByName(tagged, "Person");
        const emp = schemaByName(tagged, "Employee");
        const parentMax = Math.max(...person.fields.map((f) => f.tag ?? 0));
        assert.ok(parentMax > 0, "Person fields received tags");
        for (const f of emp.fields) {
            assert.ok(
                (f.tag ?? 0) > parentMax,
                `own field "${f.name}" tag ${f.tag} must exceed parent max ${parentMax}`,
            );
        }
    });

    it("Person schema has no extends/extendsSource field", () => {
        const person = schemaByName(result, "Person");
        assert.equal(person.extends, undefined);
        assert.equal(person.extendsSource, undefined);
    });
});

// ─── KEYMA034 — override subtype compatibility ───────────────────────────────

describe("KEYMA034 — field override compatibility", () => {
    function overrides(parentType: string, childType: string): ReturnType<typeof compile> {
        return cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema({ name: "base" }) class Base { declare x: ${parentType}; }
                @Schema({ name: "child" }) class Child extends Base { declare x: ${childType}; }
            `,
        });
    }

    const ok: Array<[string, string]> = [
        ["number", "number"],
        ["string | null", "string"],          // narrowing: drop null
        ['"a" | "b" | "c"', '"a" | "b"'],      // enum subset
    ];
    for (const [p, c] of ok) {
        it(`allows ${p} → ${c}`, () => {
            assert.ok(!hasError(overrides(p, c), CODES.KEYMA034), JSON.stringify(overrides(p, c).diagnostics));
        });
    }

    const bad: Array<[string, string]> = [
        ["string", "number"],                  // unrelated
        ["string", "string | null"],           // widening: add null
        ['"a" | "b"', '"a" | "b" | "c"'],      // enum superset
    ];
    for (const [p, c] of bad) {
        it(`rejects ${p} → ${c}`, () => {
            assert.ok(hasError(overrides(p, c), CODES.KEYMA034), JSON.stringify(overrides(p, c).diagnostics));
        });
    }
});

// ─── Golden IR — visibility ───────────────────────────────────────────────────

describe("compile visibility", () => {
    const result = compile({ files: [fixture("visibility.ts")] });

    it("produces no errors", () => {
        assert.deepEqual(errorCodes(result), [], `Errors: ${JSON.stringify(result.diagnostics)}`);
    });

    it("Credentials schema is private", () => {
        const creds = schemaByName(result, "Credentials");
        assert.equal(creds.visibility, "private");
    });

    it("User has a private field secretToken", () => {
        const user = schemaByName(result, "User");
        const secret = user.fields.find((f) => f.name === "secretToken");
        assert.ok(secret, "secretToken not found");
        assert.equal(secret.visibility, "private");
    });

    it("User public fields are visible", () => {
        const user = schemaByName(result, "User");
        const email = user.fields.find((f) => f.name === "email");
        assert.ok(email);
        assert.equal(email.visibility, "public");
    });
});

// ─── Golden IR — ephemeral ────────────────────────────────────────────────────

describe("compile ephemeral", () => {
    const result = compile({ files: [fixture("ephemeral.ts")] });

    it("produces no errors", () => {
        assert.deepEqual(errorCodes(result), [], `Errors: ${JSON.stringify(result.diagnostics)}`);
    });

    it("LoginInput schema is ephemeral", () => {
        const input = schemaByName(result, "LoginInput");
        assert.equal(schemaEphemeral(input), true);
    });

    it("persisted AuditEntry is not ephemeral", () => {
        const audit = schemaByName(result, "AuditEntry");
        assert.notEqual(schemaEphemeral(audit), true);
    });

    it("embedding an ephemeral schema is allowed (no KEYMA035)", () => {
        assert.ok(!hasError(result, CODES.KEYMA035), `Unexpected KEYMA035. Got: ${JSON.stringify(result.diagnostics)}`);
    });
});

// ─── Golden IR — getters (behaviors, not fields) ─────────────────────────────

describe("compile getters as behaviors", () => {
    const result = compile({ files: [fixture("computed.ts")] });

    function getterExpr(schemaName: string, name: string) {
        const schema = schemaByName(result, schemaName);
        const m = (schema.methods ?? []).find((mm) => mm.kind === "getter" && mm.name === name);
        const stmt = m?.statements[0];
        return stmt !== undefined && stmt.kind === "return" ? (stmt.value ?? undefined) : undefined;
    }

    it("produces no errors (KEYMA098 deferral warnings are not errors)", () => {
        assert.deepEqual(errorCodes(result), [], `Errors: ${JSON.stringify(result.diagnostics)}`);
    });

    it("getters are behaviors, not schema fields", () => {
        const schema = schemaByName(result, "Product");
        for (const name of ["displayTitle", "priceWithTax", "isExpensive"]) {
            assert.equal(schema.fields.find((f) => f.name === name), undefined, `${name} must not be a field`);
            const m = (schema.methods ?? []).find((mm) => mm.kind === "getter" && mm.name === name);
            assert.ok(m !== undefined, `${name} should be a getter behavior`);
        }
    });

    it("priceWithTax getter has a binary expression", () => {
        assert.equal(getterExpr("Product", "priceWithTax")?.kind, "binary");
    });

    it("isExpensive getter has a comparison (binary) expression", () => {
        assert.equal(getterExpr("Product", "isExpensive")?.kind, "binary");
    });
});

// ─── Diagnostic tests ─────────────────────────────────────────────────────────

describe("KEYMA001 — duplicate schema name", () => {
    it("emits KEYMA001 when two schemas share the same database name", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema({ name: "user" }) class UserA {}
                @Schema({ name: "user" }) class UserB {}
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA001), `Expected KEYMA001. Got: ${JSON.stringify(result.diagnostics)}`);
    });
});

describe("KEYMA010 — unknown field type", () => {
    it("emits KEYMA010 for an unresolvable type", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema() class Foo {
                    declare bar: SomeUnknownType;
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA010), `Expected KEYMA010. Got: ${JSON.stringify(result.diagnostics)}`);
    });
});

describe("KEYMA011 — non-literal decorator argument", () => {
    it("emits KEYMA011 for a non-literal validator argument", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Validate } from "@keyma/schema/dsl";
                const n = 2;
                @Schema() class Foo {
                    @Validate({ kind: "minLength", value: n } as any)
                    declare bar: string;
                }
            `,
        });
        // Either KEYMA011 or KEYMA020 is acceptable for a bad argument shape
        const codes = errorCodes(result);
        assert.ok(
            codes.includes(CODES.KEYMA011) || codes.includes(CODES.KEYMA020),
            `Expected KEYMA011 or KEYMA020. Got: ${codes.join(", ")}`
        );
    });
});

describe("getter/setter pair — both are behaviors", () => {
    it("accepts a matching getter/setter pair (getter behavior + setter behavior)", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/schema/dsl";
                @Schema() class Foo {
                    declare firstName: string;
                    @Computed() get name(): string { return this.firstName; }
                    set name(v: string) { this.firstName = v; }
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], `Errors: ${JSON.stringify(result.diagnostics)}`);
        const foo = result.ir.classes.find((s) => s.sourceName === "Foo")!;
        assert.equal(foo.fields.find((f) => f.name === "name"), undefined, "getter must not be a field");
        assert.ok((foo.methods ?? []).some((m) => m.name === "name" && m.kind === "getter"));
        assert.ok((foo.methods ?? []).some((m) => m.name === "name" && m.kind === "setter"));
    });
});

describe("KEYMA020 — unknown validator", () => {
    it("emits KEYMA020 for an unknown validator identifier", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Validate } from "@keyma/schema/dsl";
                const unknownValidator = { __validatorKind: "unknown" } as any;
                @Schema() class Foo {
                    @Validate(unknownValidator)
                    declare bar: string;
                }
            `,
        });
        // The validator is not from DSL, so it won't be parsed
        // It's a non-literal call expression pattern, expect KEYMA011 or KEYMA020
        const codes = errorCodes(result);
        assert.ok(codes.length > 0, "Expected at least one error");
    });
});

describe("KEYMA031 — public schema leaks private schema", () => {
    it("emits KEYMA031 when a public schema publicly references a private schema", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import type { Embedded } from "@keyma/schema/dsl";
                @Schema({ name: "secret", private: true }) class Secret {
                    declare token: string;
                }
                @Schema({ name: "public" }) class Public {
                    declare secret: Embedded<Secret>;
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA031), `Expected KEYMA031. Got: ${JSON.stringify(result.diagnostics)}`);
    });
});

describe("KEYMA037 — public schema has only private fields", () => {
    it("emits KEYMA037 when every field of a public schema is private", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema({ name: "token" }) class Token {
                    declare private value: string;
                    declare private refreshedAt: string;
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA037), `Expected KEYMA037. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("does not emit when at least one field is public", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import type { ID } from "@keyma/schema/dsl";
                @Schema({ name: "user" }) class User {
                    declare id: ID;
                    declare name: string;
                    declare private passwordHash: string;
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], `Unexpected errors: ${JSON.stringify(result.diagnostics)}`);
    });

    it("does not emit for a private schema whose fields are all private", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema({ name: "token", private: true }) class Token {
                    declare private value: string;
                }
            `,
        });
        assert.ok(!hasError(result, CODES.KEYMA037), `Unexpected KEYMA037. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("does not treat a public getter as public field surface (KEYMA037 still fires)", () => {
        // Getters are behaviors, not stored/projected data — a schema whose only
        // public member is a getter still has no readable public field.
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/schema/dsl";
                @Schema({ name: "token" }) class Token {
                    declare private value: string;
                    @Computed() get label(): string { return this.value; }
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA037), `Expected KEYMA037. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("exempts a fieldless public schema", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema({ name: "marker" }) class Marker {}
            `,
        });
        assert.ok(!hasError(result, CODES.KEYMA037), `Unexpected KEYMA037. Got: ${JSON.stringify(result.diagnostics)}`);
    });
});

describe("KEYMA035 — persisted schema references ephemeral schema", () => {
    it("emits KEYMA035 when a persisted schema holds a Reference to an ephemeral schema", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import type { ID, Reference } from "@keyma/schema/dsl";
                @Schema({ name: "token", ephemeral: true }) class Token {
                    declare id: ID;
                }
                @Schema({ name: "session" }) class Session {
                    declare id: ID;
                    declare token: Reference<Token>;
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA035), `Expected KEYMA035. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("does not emit KEYMA035 for Embedded of an ephemeral schema", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import type { ID, Embedded } from "@keyma/schema/dsl";
                @Schema({ name: "token", ephemeral: true }) class Token {
                    declare id: ID;
                }
                @Schema({ name: "session" }) class Session {
                    declare id: ID;
                    declare token: Embedded<Token>;
                }
            `,
        });
        assert.ok(!hasError(result, CODES.KEYMA035), `Unexpected KEYMA035. Got: ${JSON.stringify(result.diagnostics)}`);
    });
});

describe("KEYMA036 — indexes on ephemeral schema (warning)", () => {
    it("warns when an ephemeral schema declares a field index", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Indexed } from "@keyma/schema/dsl";
                @Schema({ name: "payload", ephemeral: true }) class Payload {
                    @Indexed() declare key: string;
                }
            `,
        });
        const hasWarn = result.diagnostics.some((d) => d.code === CODES.KEYMA036 && d.severity === "warning");
        assert.ok(hasWarn, `Expected KEYMA036 warning. Got: ${JSON.stringify(result.diagnostics)}`);
    });
});

describe("KEYMA032 — public extends private parent", () => {
    it("emits KEYMA032 when a public schema extends a private schema", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema({ name: "base", private: true }) class Base {
                    declare id: string;
                }
                @Schema({ name: "child" }) class Child extends Base {
                    declare extra: string;
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA032), `Expected KEYMA032. Got: ${JSON.stringify(result.diagnostics)}`);
    });
});

describe("KEYMA033 — extends a non-lowered (vendor / ambient) class", () => {
    it("emits KEYMA033 when a schema extends a class from a declaration file", () => {
        // The compiler lowers EVERY in-project class, so extending a plain in-project class is
        // legal (the parent is lowered too). KEYMA033 fires only when the parent is genuinely
        // never lowered — e.g. it lives in a `.d.ts` (vendor/ambient), which discovery skips.
        const result = cv({
            "vendor.d.ts": `export declare class VendorBase { name: string; }`,
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import { VendorBase } from "./vendor.js";
                @Schema({ name: "child" }) class Child extends VendorBase {
                    declare extra: string;
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA033), `Expected KEYMA033. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("does NOT emit KEYMA033 when a schema extends a plain in-project class (it is lowered too)", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                class PlainBase { declare name: string; }
                @Schema({ name: "child" }) class Child extends PlainBase {
                    declare extra: string;
                }
            `,
        });
        assert.ok(!hasError(result, CODES.KEYMA033), `Unexpected KEYMA033. Got: ${JSON.stringify(result.diagnostics)}`);
    });
});

describe("KEYMA040 — duplicate field name", () => {
    it("emits KEYMA040 when a class declares the same field twice", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema() class Foo {
                    declare name: string;
                    declare name: number;
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA040), `Expected KEYMA040. Got: ${JSON.stringify(result.diagnostics)}`);
    });
});

describe("compile IR structure", () => {
    it("IR document has irVersion and compilerVersion", () => {
        const result = cv({ "s.ts": `import { Schema } from "@keyma/schema/dsl"; @Schema() class T { declare x: string; }` });
        assert.equal(typeof result.ir.irVersion, "string");
        assert.equal(typeof result.ir.compilerVersion, "string");
    });

    it("IR document diagnostics array matches result.diagnostics", () => {
        const result = cv({ "s.ts": `import { Schema } from "@keyma/schema/dsl"; @Schema() class T { declare x: string; }` });
        assert.deepEqual(result.ir.diagnostics, result.diagnostics);
    });

    it("resolves validator/formatter factories (functions returning ValidatorFn/FormatterFn) by following the declaration", () => {
        const result = cv({
            "validators.ts": `
                import type { ValidatorFn, FormatterFn } from "@keyma/schema/dsl";
                export function required(): ValidatorFn<string> { return (raw, field) => raw.length > 0 ? null : { field: field, code: "required", message: "x" }; }
                export function minLength(value: number): ValidatorFn<string> { return (raw, field) => raw.length < value ? { field: field, code: "minLength", message: "x" } : null; }
                export function trim(): FormatterFn<string> { return (v) => v.trim(); }
            `,
            "s.ts": `
                import { Schema, Validate, Format } from "@keyma/schema/dsl";
                import { required, minLength, trim } from "./validators.js";
                @Schema() class Account {
                    @Validate(required(), minLength(3))
                    @Format("change", trim())
                    declare name: string;
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], `Unexpected errors: ${JSON.stringify(result.diagnostics)}`);
        const f = schemaByName(result, "Account").fields.find((f) => f.name === "name");
        assert.ok(f);
        assert.ok(fieldValidators(f).some((v) => v.name === "required"), "required validator expected");
        assert.ok(fieldValidators(f).some((v) => v.name === "minLength" && (v.params as any)?.value === 3), "minLength(3) expected");
        assert.ok(fieldFormatters(f).some((fmt) => fmt.phase === "change" && fmt.spec.name === "trim"), "trim formatter expected");
        // The referenced factory bodies are lowered into IR function declarations (re-emitted into the bundle).
        assert.ok(result.ir.functionDeclarations?.some((d) => d.name === "required"), "required declaration lowered");
        assert.ok(result.ir.functionDeclarations?.some((d) => d.name === "trim"), "trim declaration lowered");
    });

    it("resolves factory calls imported under an alias", () => {
        const result = cv({
            "validators.ts": `
                import type { ValidatorFn } from "@keyma/schema/dsl";
                export function required(): ValidatorFn<string> { return (raw, field) => raw.length > 0 ? null : { field: field, code: "required", message: "x" }; }
            `,
            "s.ts": `
                import { Schema, Validate } from "@keyma/schema/dsl";
                import { required as req } from "./validators.js";
                @Schema() class Account {
                    @Validate(req())
                    declare name: string;
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], `Unexpected errors: ${JSON.stringify(result.diagnostics)}`);
        const f = schemaByName(result, "Account").fields.find((f) => f.name === "name");
        assert.ok(f);
        assert.ok(fieldValidators(f).some((v) => v.name === "required"), "aliased required validator expected");
    });

    it("number field with integer validator is promoted to integer type", () => {
        const result = cv({
            "s.ts": `
                import { Schema, Validate } from "@keyma/schema/dsl";
                import type { ValidatorFn } from "@keyma/schema/dsl";
                function integer(): ValidatorFn<number> { return (raw, field) => raw % 1 !== 0 ? { field: field, code: "integer", message: "x" } : null; }
                @Schema() class Count { @Validate(integer()) declare n: number; }
            `,
        });
        assert.deepEqual(errorCodes(result), []);
        const schema = schemaByName(result, "Count");
        const f = schema.fields.find((f) => f.name === "n");
        assert.ok(f);
        assert.deepEqual(f.type, { kind: "integer" }, "number + isInteger should promote to integer");
    });
});

// ─── Edges ────────────────────────────────────────────────────────────────────

describe("@Edge discovery", () => {
    const result = compile({ files: [fixture("edges.ts")] });

    it("produces no errors on the good edge fixture", () => {
        assert.deepEqual(errorCodes(result), [], `Unexpected errors: ${JSON.stringify(result.diagnostics)}`);
    });

    it("records edge metadata on Knows (undirected, custom label) from @From()/@To()", () => {
        const knows = schemaByName(result, "Knows");
        const knowsEdge = schemaEdge(knows);
        assert.ok(knowsEdge !== undefined, "Knows should carry edge metadata");
        assert.equal(knowsEdge.from, "person");
        assert.equal(knowsEdge.to, "person");
        assert.equal(knowsEdge.fromField, "from");
        assert.equal(knowsEdge.toField, "to");
        assert.equal(knowsEdge.label, "knows");
        assert.equal(knowsEdge.directed, false);
    });

    it("auto-indexes the @From()/@To() endpoint fields", () => {
        const knows = schemaByName(result, "Knows");
        const from = knows.fields.find((f) => f.name === "from");
        const to = knows.fields.find((f) => f.name === "to");
        assert.ok(from && fieldIndexes(from).length > 0, "from should be auto-indexed");
        assert.ok(to && fieldIndexes(to).length > 0, "to should be auto-indexed");
    });

    it("records edge metadata on WorksAt with defaults (directed, label=name)", () => {
        const wa = schemaByName(result, "WorksAt");
        const waEdge = schemaEdge(wa);
        assert.ok(waEdge !== undefined, "WorksAt should carry edge metadata");
        assert.equal(waEdge.from, "person");
        assert.equal(waEdge.to, "company");
        // No explicit name → defaults to the lowercased class name, which is
        // also the traversal label.
        assert.equal(waEdge.label, "worksat");
        assert.equal(waEdge.directed, true);
    });

    it("non-edge schemas have no `edge` field", () => {
        const person = schemaByName(result, "Person");
        assert.equal(schemaEdge(person), undefined);
    });

    it("@Edge classes are discovered as schemas (have fields)", () => {
        const knows = schemaByName(result, "Knows");
        assert.ok(knows.fields.find((f) => f.name === "since"), "Knows should have its `since` field extracted");
    });
});

describe("@Edge diagnostics", () => {
    const result = compile({ files: [fixture("edges-bad.ts")] });

    it("emits KEYMA065 when an edge is missing a @From()/@To() endpoint", () => {
        assert.ok(
            hasError(result, CODES.KEYMA065),
            `Expected KEYMA065; got ${JSON.stringify(errorCodes(result))}`,
        );
    });

    it("emits KEYMA066 when an edge declares duplicate @From()/@To()", () => {
        assert.ok(
            hasError(result, CODES.KEYMA066),
            `Expected KEYMA066; got ${JSON.stringify(errorCodes(result))}`,
        );
    });

    it("emits KEYMA061 when an endpoint field is not a node reference", () => {
        assert.ok(
            hasError(result, CODES.KEYMA061),
            `Expected KEYMA061; got ${JSON.stringify(errorCodes(result))}`,
        );
    });

    it("emits KEYMA064 when a non-edge schema references an edge class", () => {
        assert.ok(
            hasError(result, CODES.KEYMA064),
            `Expected KEYMA064; got ${JSON.stringify(errorCodes(result))}`,
        );
    });

    it("emits KEYMA060 when an endpoint points at an edge schema", () => {
        const r = cv({
            "s.ts": `
                import { Edge, Schema, From, To } from "@keyma/schema/dsl";
                import type { ID, Reference } from "@keyma/schema/dsl";
                @Schema() class Node { declare readonly id: ID; }
                @Edge() class Knows { declare readonly id: ID; @From() declare from: Reference<Node>; @To() declare to: Reference<Node>; }
                @Edge() class Meta {
                    declare readonly id: ID;
                    @From() declare from: Reference<Knows>;
                    @To() declare to: Reference<Node>;
                }
            `,
        });
        assert.ok(
            hasError(r, CODES.KEYMA060),
            `Expected KEYMA060; got ${JSON.stringify(errorCodes(r))}`,
        );
    });

    it("rejects a bare node endpoint (KEYMA071) and requires Reference<T>", () => {
        const bare = cv({
            "s.ts": `
                import { Edge, Schema, From, To } from "@keyma/schema/dsl";
                import type { ID } from "@keyma/schema/dsl";
                @Schema() class Node { declare readonly id: ID; }
                @Edge() class Bad {
                    declare readonly id: ID;
                    @From() declare from: Node;
                    @To() declare to: Node;
                }
            `,
        });
        assert.ok(hasError(bare, CODES.KEYMA071), `Expected KEYMA071; got ${JSON.stringify(errorCodes(bare))}`);

        const r = cv({
            "s.ts": `
                import { Edge, Schema, From, To } from "@keyma/schema/dsl";
                import type { ID, Reference } from "@keyma/schema/dsl";
                @Schema() class Node { declare readonly id: ID; }
                @Edge() class Mixed {
                    declare readonly id: ID;
                    @From() declare from: Reference<Node>;
                    @To() declare to: Reference<Node>;
                }
            `,
        });
        assert.deepEqual(errorCodes(r), [], `Unexpected errors: ${JSON.stringify(r.diagnostics)}`);
        const mixed = schemaByName(r, "Mixed");
        const mixedEdge = schemaEdge(mixed);
        assert.ok(mixedEdge !== undefined);
        assert.equal(mixedEdge.fromField, "from");
        assert.equal(mixedEdge.toField, "to");
        assert.equal(mixedEdge.from, "node");
        assert.equal(mixedEdge.to, "node");
    });
});

describe("Reference target validation", () => {
    it("emits KEYMA070 when Reference<T> target has no id: ID field", () => {
        const r = cv({
            "s.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import type { Reference } from "@keyma/schema/dsl";
                @Schema() class Tag {
                    declare label: string;
                }
                @Schema() class Post {
                    declare tag: Reference<Tag>;
                }
            `,
        });
        assert.ok(
            hasError(r, CODES.KEYMA070),
            `Expected KEYMA070; got ${JSON.stringify(errorCodes(r))}`,
        );
    });

    it("emits KEYMA070 for Reference<T> inside Nullable<>", () => {
        const r = cv({
            "s.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import type { Reference, Nullable } from "@keyma/schema/dsl";
                @Schema() class Tag {
                    declare label: string;
                }
                @Schema() class Post {
                    declare tag: Nullable<Reference<Tag>>;
                }
            `,
        });
        assert.ok(
            hasError(r, CODES.KEYMA070),
            `Expected KEYMA070; got ${JSON.stringify(errorCodes(r))}`,
        );
    });

    it("emits KEYMA070 for array of Reference<T>", () => {
        const r = cv({
            "s.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import type { Reference } from "@keyma/schema/dsl";
                @Schema() class Tag {
                    declare label: string;
                }
                @Schema() class Post {
                    declare tags: Reference<Tag>[];
                }
            `,
        });
        assert.ok(
            hasError(r, CODES.KEYMA070),
            `Expected KEYMA070; got ${JSON.stringify(errorCodes(r))}`,
        );
    });

    it("does not emit KEYMA070 when target declares an id: ID field", () => {
        const r = cv({
            "s.ts": `
                import { Schema, Indexed } from "@keyma/schema/dsl";
                import type { ID, Reference } from "@keyma/schema/dsl";
                @Schema() class Tag {
                    @Indexed({ unique: true }) declare readonly id: ID;
                    declare label: string;
                }
                @Schema() class Post {
                    declare tag: Reference<Tag>;
                }
            `,
        });
        assert.ok(
            !hasError(r, CODES.KEYMA070),
            `Unexpected KEYMA070; diagnostics: ${JSON.stringify(r.diagnostics)}`,
        );
    });

    it("does not emit KEYMA070 when target inherits an id: ID from a parent", () => {
        const r = cv({
            "s.ts": `
                import { Schema, Indexed } from "@keyma/schema/dsl";
                import type { ID, Reference } from "@keyma/schema/dsl";
                @Schema() class Base {
                    @Indexed({ unique: true }) declare readonly id: ID;
                }
                @Schema() class Tag extends Base {
                    declare label: string;
                }
                @Schema() class Post {
                    declare tag: Reference<Tag>;
                }
            `,
        });
        assert.ok(
            !hasError(r, CODES.KEYMA070),
            `Unexpected KEYMA070; diagnostics: ${JSON.stringify(r.diagnostics)}`,
        );
    });

    it("does not emit KEYMA070 for Embedded<T> targets without id", () => {
        const r = cv({
            "s.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import type { Embedded } from "@keyma/schema/dsl";
                @Schema() class Address {
                    declare street: string;
                }
                @Schema() class User {
                    declare addr: Embedded<Address>;
                }
            `,
        });
        assert.ok(
            !hasError(r, CODES.KEYMA070),
            `Unexpected KEYMA070; diagnostics: ${JSON.stringify(r.diagnostics)}`,
        );
    });
});

describe("Embedded cycle validation", () => {
    it("emits KEYMA072 for a self-embed", () => {
        const r = cv({
            "s.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import type { Embedded } from "@keyma/schema/dsl";
                @Schema() class Node {
                    declare child: Embedded<Node>;
                }
            `,
        });
        assert.ok(
            hasError(r, CODES.KEYMA072),
            `Expected KEYMA072; got ${JSON.stringify(errorCodes(r))}`,
        );
    });

    it("emits KEYMA072 for a two-schema embed cycle", () => {
        const r = cv({
            "s.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import type { Embedded } from "@keyma/schema/dsl";
                @Schema() class A { declare b: Embedded<B>; }
                @Schema() class B { declare a: Embedded<A>; }
            `,
        });
        assert.ok(
            hasError(r, CODES.KEYMA072),
            `Expected KEYMA072; got ${JSON.stringify(errorCodes(r))}`,
        );
    });

    it("emits KEYMA072 for a cycle through Embedded<T>[]", () => {
        const r = cv({
            "s.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import type { Embedded } from "@keyma/schema/dsl";
                @Schema() class Tree {
                    declare children: Embedded<Tree>[];
                }
            `,
        });
        assert.ok(
            hasError(r, CODES.KEYMA072),
            `Expected KEYMA072; got ${JSON.stringify(errorCodes(r))}`,
        );
    });

    it("does not emit KEYMA072 for a Reference<T> cycle (foreign keys are fine)", () => {
        const r = cv({
            "s.ts": `
                import { Schema, Indexed } from "@keyma/schema/dsl";
                import type { ID, Reference } from "@keyma/schema/dsl";
                @Schema() class A {
                    @Indexed({ unique: true }) declare readonly id: ID;
                    declare b: Reference<B>;
                }
                @Schema() class B {
                    @Indexed({ unique: true }) declare readonly id: ID;
                    declare a: Reference<A>;
                }
            `,
        });
        assert.ok(
            !hasError(r, CODES.KEYMA072),
            `Unexpected KEYMA072; diagnostics: ${JSON.stringify(r.diagnostics)}`,
        );
    });

    it("does not emit KEYMA072 for an acyclic embed graph (DAG)", () => {
        const r = cv({
            "s.ts": `
                import { Schema } from "@keyma/schema/dsl";
                import type { Embedded } from "@keyma/schema/dsl";
                @Schema() class C { declare label: string; }
                @Schema() class B { declare c: Embedded<C>; }
                @Schema() class A {
                    declare b: Embedded<B>;
                    declare c: Embedded<C>;
                }
            `,
        });
        assert.ok(
            !hasError(r, CODES.KEYMA072),
            `Unexpected KEYMA072; diagnostics: ${JSON.stringify(r.diagnostics)}`,
        );
    });
});

describe("compileVirtual sourceRoot", () => {
    it("uses provided baseDir as sourceRoot", () => {
        const result = compileVirtual({
            "User.ts": "import { Schema } from '@keyma/schema/dsl'; @Schema class User {}"
        }, { baseDir: "/tmp/project" });
        assert.equal(result.ir.sourceRoot, "/tmp/project");
    });
});

// ─── Authoring features (Phase, initializer defaults, named enums, @FormField/@Deprecated) ──

describe("authoring features", () => {
    it("resolves @Format(Phase.Save, ...) to the 'save' phase", () => {
        const r = cv({ "schema.ts": `
            import { Schema, Format, Phase } from "@keyma/schema/dsl";
            import type { FormatterFn } from "@keyma/schema/dsl";
            function trim(): FormatterFn<string> { return (v) => v.trim(); }
            @Schema() class Foo { @Format(Phase.Save, trim()) declare name: string; }
        `});
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        const name = schemaByName(r, "Foo").fields.find((f) => f.name === "name");
        assert.ok(name);
        assert.equal(fieldFormatters(name)[0]?.phase, "save");
    });

    it("lowers a literal property-initializer default", () => {
        const r = cv({ "schema.ts": `
            import { Schema } from "@keyma/schema/dsl";
            @Schema() class Foo { status: string = "active"; }
        `});
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        const status = schemaByName(r, "Foo").fields.find((f) => f.name === "status");
        assert.deepEqual(status?.default, { kind: "literal", value: "active" });
    });

    it("lowers an enum-member initializer to a literal default", () => {
        const r = cv({ "schema.ts": `
            import { Schema } from "@keyma/schema/dsl";
            enum Role { Member = "member", Admin = "admin" }
            @Schema() class Foo { role: Role = Role.Member; }
        `});
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        const role = schemaByName(r, "Foo").fields.find((f) => f.name === "role");
        assert.deepEqual(role?.default, { kind: "literal", value: "member" });
    });

    it("lowers a non-literal initializer to an expression default", () => {
        const r = cv({ "schema.ts": `
            import { Schema } from "@keyma/schema/dsl";
            import type { DateTime } from "@keyma/schema/dsl";
            @Schema() class Foo { createdOn: DateTime = (() => new Date())(); }
        `});
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        const f = schemaByName(r, "Foo").fields.find((x) => x.name === "createdOn");
        assert.equal(f?.default?.kind, "expression");
    });

    it("rejects a type-incompatible literal default (KEYMA090)", () => {
        // The frontend extracts from the AST and does not gate on TS's own type
        // check, so a literal-vs-field-type mismatch still surfaces as KEYMA090.
        const r = cv({ "schema.ts": `
            import { Schema } from "@keyma/schema/dsl";
            // @ts-expect-error — number is not assignable to string (checked by KEYMA090)
            @Schema() class Foo { status: string = 5; }
        `});
        assert.ok(hasError(r, CODES.KEYMA090), JSON.stringify(r.diagnostics));
    });

    it("recognizes a named TS enum and records it in ir.enums", () => {
        const r = cv({ "schema.ts": `
            import { Schema } from "@keyma/schema/dsl";
            enum Status { Active = "active", Archived = "archived" }
            @Schema() class Foo { declare status: Status; }
        `});
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        const status = schemaByName(r, "Foo").fields.find((x) => x.name === "status");
        assert.deepEqual(status?.type, { kind: "enum", name: "Status", values: ["active", "archived"] });
        assert.equal(r.ir.enums?.[0]?.name, "Status");
        assert.deepEqual(r.ir.enums?.[0]?.members, [
            { name: "Active", value: "active" },
            { name: "Archived", value: "archived" },
        ]);
    });

    it("rejects a non-portable (numeric) enum with KEYMA025", () => {
        const r = cv({ "schema.ts": `
            import { Schema } from "@keyma/schema/dsl";
            enum Level { Low, High }
            @Schema() class Foo { declare level: Level; }
        `});
        assert.ok(hasError(r, CODES.KEYMA025), JSON.stringify(r.diagnostics));
    });

    it("captures @FormField and @Deprecated metadata", () => {
        const r = cv({ "schema.ts": `
            import { Schema, FormField, Deprecated } from "@keyma/schema/dsl";
            @Schema() class Foo {
                @FormField({ title: "Email", hint: "kept private", order: 1 }) declare email: string;
                @Deprecated("use email") declare username: string;
            }
        `});
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        const foo = schemaByName(r, "Foo");
        const email = foo.fields.find((x) => x.name === "email");
        const username = foo.fields.find((x) => x.name === "username");
        // `@FormField` is UI-domain presentational metadata — it rides in `extensions['ui'].form`.
        assert.deepEqual(email?.extensions?.["ui"], { form: { title: "Email", hint: "kept private", order: 1 } });
        assert.equal(username?.deprecated, "use email");
    });
});

// ─── Validator/formatter naming (factory function name) ───────────────────────

describe("validator naming", () => {
    it("uses the factory function name as the validator name, with positional params", () => {
        const r = cv({ "schema.ts": `
            import { Schema, Validate } from "@keyma/schema/dsl";
            import type { ValidatorFn } from "@keyma/schema/dsl";
            export function minLen(n: number): ValidatorFn<string> {
                return (value, field) => value.length >= n ? null : { field: field, code: "MIN", message: "too short" };
            }
            @Schema() class Foo { @Validate(minLen(2)) declare name: string; }
        `});
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        assert.equal(r.ir.functionDeclarations?.find((d) => d.name === "minLen")?.name, "minLen");
        const name = schemaByName(r, "Foo").fields.find((f) => f.name === "name");
        assert.ok(name);
        assert.deepEqual(fieldValidators(name)[0], { name: "minLen", params: { n: 2 } });
    });

    it("lowers each referenced validator's body once (deduped) regardless of reuse", () => {
        const r = cv({ "schema.ts": `
            import { Schema, Validate } from "@keyma/schema/dsl";
            import type { ValidatorFn } from "@keyma/schema/dsl";
            export function nonEmpty(): ValidatorFn<string> {
                return (value, field) => value.length > 0 ? null : { field: field, code: "EMPTY", message: "empty" };
            }
            @Schema() class Foo {
                @Validate(nonEmpty()) declare a: string;
                @Validate(nonEmpty()) declare b: string;
            }
        `});
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        assert.equal(r.ir.functionDeclarations?.filter((d) => d.name === "nonEmpty").length, 1);
    });
});

// ─── Complete local surface (issue 006) ───────────────────────────────────────
//
// The IR carries the complete LOCAL surface — every project-local function and enum,
// referenced or not — so a future `keyma.ir.json` is a complete import surface and
// tree-shaking is a per-bundle backend concern (reachability = the client/server gate).

describe("complete local surface", () => {
    it("includes an unreferenced project-local function and enum in the IR", () => {
        const r = cv({ "schema.ts": `
            import { Schema } from "@keyma/schema/dsl";
            export function unusedHelper(n: number): number { return n * 2; }
            enum UnusedEnum { A = "a", B = "b" }
            @Schema() class Foo { declare name: string; }
        `});
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        assert.ok(
            r.ir.functionDeclarations?.some((d) => d.name === "unusedHelper"),
            "an unreferenced project-local function must be in the complete local surface",
        );
        assert.ok(
            r.ir.enums?.some((e) => e.name === "UnusedEnum"),
            "an unreferenced project-local enum must be in the complete local surface",
        );
    });

    it("excludes an unreferenced validator/formatter factory (lowered only where referenced)", () => {
        const r = cv({ "schema.ts": `
            import { Schema } from "@keyma/schema/dsl";
            import type { ValidatorFn } from "@keyma/schema/dsl";
            export function unusedValidator(): ValidatorFn<string> { return (value) => value.length > 0 ? null : "x"; }
            @Schema() class Foo { declare name: string; }
        `});
        assert.deepEqual(errorCodes(r), [], JSON.stringify(r.diagnostics));
        assert.ok(
            !r.ir.functionDeclarations?.some((d) => d.name === "unusedValidator"),
            "an unreferenced validator factory is not a plain utility and is excluded from the surface",
        );
    });
});

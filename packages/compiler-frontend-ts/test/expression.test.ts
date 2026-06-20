import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { compile, compileVirtual } from "../src/compile.js";
import * as CODES from "../src/diagnostics.js";
import type { IRExpression } from "@keyma/ir";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.join(__dirname, "..", "..", "test", "fixtures");
const SNAPSHOTS = path.join(__dirname, "..", "..", "test", "snapshots");

function fixture(name: string): string {
    return path.join(FIXTURES, name);
}

const VIRTUAL_BASE = path.join(__dirname, "..", "..", "src");

function cv(sources: Record<string, string>) {
    return compileVirtual(sources, { baseDir: VIRTUAL_BASE });
}

function errorCodes(result: ReturnType<typeof compile>): string[] {
    return result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

function hasError(result: ReturnType<typeof compile>, code: string): boolean {
    return result.diagnostics.some((d) => d.code === code && d.severity === "error");
}

// ─── Snapshot tests for every supported expression kind ──────────────────────

describe("expression lowering — snapshot", () => {
    const result = compile({ files: [fixture("computed-extended.ts")] });

    const rawSnapshot = readFileSync(path.join(SNAPSHOTS, "computed-expressions.json"), "utf-8");
    const snapshots = JSON.parse(rawSnapshot) as Record<string, IRExpression>;

    it("produces no errors on the extended fixture", () => {
        assert.deepEqual(errorCodes(result), [], `Unexpected errors: ${JSON.stringify(result.diagnostics)}`);
    });

    const schema = result.ir.schemas.find((s) => s.sourceName === "Product");

    for (const [fieldName, expectedExpr] of Object.entries(snapshots)) {
        it(`lowers "${fieldName}" to the correct IRExpression`, () => {
            assert.ok(schema !== undefined, "Product schema not found");
            const field = schema.fields.find((f) => f.name === fieldName);
            assert.ok(field !== undefined, `field "${fieldName}" not found in schema`);
            assert.ok(field.computed !== undefined, `field "${fieldName}" should be computed`);
            assert.deepEqual(
                field.computed.expression,
                expectedExpr,
                `IRExpression mismatch for "${fieldName}"`
            );
        });
    }
});

// ─── KEYMA014 — unsupported expressions ──────────────────────────────────────

describe("KEYMA014 — unsupported computed getter expressions", () => {
    it("emits KEYMA014 for a call expression in a getter body", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                declare function compute(): string;
                @Schema() class Foo {
                    @Computed() get name(): string { return compute(); }
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA014), `Expected KEYMA014. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("emits KEYMA014 for a method call on this in a getter body", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    private helper(): string { return "x"; }
                    @Computed() get name(): string { return this.helper(); }
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA014), `Expected KEYMA014. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("emits KEYMA014 for an array literal in a getter body", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    declare items: string[];
                    @Computed() get snapshot(): string[] { return []; }
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA014), `Expected KEYMA014. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("emits KEYMA014 for a multi-statement getter body", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    declare n: number;
                    @Computed() get doubled(): number {
                        const x = this.n;
                        return x * 2;
                    }
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA014), `Expected KEYMA014. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("emits KEYMA014 for a getter with no return statement", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    declare label: string;
                    @Computed() get computed(): void {
                        void this.label;
                    }
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA014), `Expected KEYMA014. Got: ${JSON.stringify(result.diagnostics)}`);
    });

});

// ─── Newly-supported getter expressions (unified portable engine) ─────────────

describe("computed getters — newly-supported portable expressions", () => {
    function lowered(src: string, field: string): IRExpression | undefined {
        const result = cv({ "schema.ts": src });
        assert.deepEqual(errorCodes(result), [], `Unexpected errors: ${JSON.stringify(result.diagnostics)}`);
        const schema = result.ir.schemas.find((s) => s.sourceName === "Foo");
        return schema?.fields.find((f) => f.name === field)?.computed?.expression;
    }

    it("lowers a `new` expression", () => {
        const expr = lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            import type { DateTime } from "@keyma/dsl";
            @Schema() class Foo {
                @Computed() get created(): DateTime { return new Date(); }
            }
        `, "created");
        assert.equal(expr?.kind, "new");
    });

    it("lowers a Date accessor method to a date intrinsic (now portable in getters)", () => {
        const expr = lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            import type { DateTime } from "@keyma/dsl";
            @Schema() class Foo {
                declare created: DateTime;
                @Computed() get year(): number { return this.created.getFullYear(); }
            }
        `, "year");
        assert.deepEqual(expr, {
            kind: "intrinsic", op: "date.getFullYear",
            receiver: { kind: "field", name: "created" }, args: [],
        });
    });

    it("lowers the static `Date.now()` to a date.now intrinsic (no receiver)", () => {
        const expr = lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                @Computed() get t(): number { return Date.now(); }
            }
        `, "t");
        assert.deepEqual(expr, { kind: "intrinsic", op: "date.now", receiver: null, args: [] });
    });

    it("KEYMA085 — rejects an unsupported Date method (e.g. a mutator) in a getter", () => {
        const r = cv({ "schema.ts": `
            import { Schema, Computed } from "@keyma/dsl";
            import type { DateTime } from "@keyma/dsl";
            @Schema() class Foo {
                declare created: DateTime;
                @Computed() get t(): number { return this.created.setHours(0); }
            }
        `});
        assert.ok(hasError(r, "KEYMA085"), JSON.stringify(r.diagnostics));
    });

    it("lowers an object literal", () => {
        const expr = lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            import type { Json } from "@keyma/dsl";
            @Schema() class Foo {
                @Computed() get meta(): Json { return { a: 1 }; }
            }
        `, "meta");
        assert.equal(expr?.kind, "object");
    });

    it("lowers a typeof expression", () => {
        const expr = lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                declare n: number;
                @Computed() get typeLabel(): string { return typeof this.n; }
            }
        `, "typeLabel");
        assert.deepEqual(expr, { kind: "typeof", operand: { kind: "field", name: "n" } });
    });

    it("lowers a string method intrinsic", () => {
        const expr = lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                declare name: string;
                @Computed() get trimmed(): string { return this.name.trim(); }
            }
        `, "trimmed");
        assert.deepEqual(expr, { kind: "intrinsic", op: "string.trim", receiver: { kind: "field", name: "name" }, args: [] });
    });

    it("lowers an array length intrinsic", () => {
        const expr = lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                declare tags: string[];
                @Computed() get count(): number { return this.tags.length; }
            }
        `, "count");
        assert.deepEqual(expr, { kind: "intrinsic", op: "array.length", receiver: { kind: "field", name: "tags" }, args: [] });
    });
});

// ─── KEYMA019 — explicit @Computed requirement ───────────────────────────────

describe("KEYMA019 — getters require @Computed()", () => {
    it("ignores an undecorated getter (warning, not a field)", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/dsl";
                @Schema() class Foo {
                    declare first: string;
                    get shout(): string { return this.first; }
                }
            `,
        });
        const foo = result.ir.schemas.find((s) => s.sourceName === "Foo");
        assert.equal(foo?.fields.find((f) => f.name === "shout"), undefined, "undecorated getter must not become a field");
        assert.ok(result.diagnostics.some((d) => d.code === CODES.KEYMA019 && d.severity === "warning"));
    });

    it("extracts a @Computed() getter as a field", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    declare first: string;
                    @Computed() get shout(): string { return this.first; }
                }
            `,
        });
        const foo = result.ir.schemas.find((s) => s.sourceName === "Foo");
        const shout = foo?.fields.find((f) => f.name === "shout");
        assert.ok(shout?.computed !== undefined, "decorated getter should be a computed field");
    });

    it("errors when @Computed() is applied to a plain property", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    @Computed() declare first: string;
                }
            `,
        });
        assert.ok(result.diagnostics.some((d) => d.code === CODES.KEYMA019 && d.severity === "error"));
    });
});

// ─── KEYMA018 — computed dependency cycles ───────────────────────────────────

describe("KEYMA018 — computed getter dependency cycles", () => {
    it("emits KEYMA018 for a self-referential computed field", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    @Computed() get a(): string { return this.a; }
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA018), `Expected KEYMA018. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("emits KEYMA018 for a two-field computed cycle", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    @Computed() get a(): string { return this.b; }
                    @Computed() get b(): string { return this.a; }
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA018), `Expected KEYMA018. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("does not flag a computed field depending on a plain field", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    declare first: string;
                    @Computed() get shout(): string { return this.first; }
                }
            `,
        });
        assert.ok(!hasError(result, CODES.KEYMA018), `Unexpected KEYMA018. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("populates dependsOn with referenced fields", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    declare first: string;
                    declare last: string;
                    @Computed() get full(): string { return \`\${this.first} \${this.last}\`; }
                }
            `,
        });
        const schema = result.ir.schemas.find((s) => s.sourceName === "Foo");
        const full = schema?.fields.find((f) => f.name === "full");
        assert.deepEqual(full?.computed?.dependsOn, ["first", "last"]);
    });
});

// ─── Getter/setter pairs (formerly KEYMA015) ──────────────────────────────────

describe("getter/setter pair — computed field + setter behavior", () => {
    it("allows a getter/setter pair: getter is a computed field, setter is a behavior", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    declare firstName: string;
                    @Computed() get name(): string { return this.firstName; }
                    set name(v: string) { this.firstName = v; }
                }
            `,
        });
        // No longer a hard error — the pair is the intended idiom now.
        assert.ok(!hasError(result, CODES.KEYMA015), `Unexpected KEYMA015. Got: ${JSON.stringify(result.diagnostics)}`);
        assert.equal(errorCodes(result).length, 0, JSON.stringify(result.diagnostics));

        const foo = result.ir.schemas.find((s) => s.sourceName === "Foo")!;
        const name = foo.fields.find((f) => f.name === "name")!;
        assert.ok(name.computed !== undefined, "getter should become a computed field");

        const setter = (foo.methods ?? []).find((m) => m.name === "name");
        assert.ok(setter !== undefined && setter.kind === "setter", "setter should become a behavior");
        assert.equal(setter!.statements[0]!.kind, "assign");
    });

    it("compiles a computed getter without a setter", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    declare firstName: string;
                    declare lastName: string;
                    @Computed() get fullName(): string { return \`\${this.firstName} \${this.lastName}\`; }
                }
            `,
        });
        assert.equal(errorCodes(result).length, 0, JSON.stringify(result.diagnostics));
    });
});

// ─── Null literal ─────────────────────────────────────────────────────────────

describe("expression lowering — null literal", () => {
    it("lowers null literal to { kind: 'literal', value: null }", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                import type { Nullable } from "@keyma/dsl";
                @Schema() class Foo {
                    @Computed() get nothing(): Nullable<string> { return null; }
                }
            `,
        });
        const schema = result.ir.schemas.find((s) => s.sourceName === "Foo");
        assert.ok(schema !== undefined);
        const field = schema.fields.find((f) => f.name === "nothing");
        assert.ok(field !== undefined);
        assert.ok(field.computed !== undefined);
        assert.deepEqual(field.computed.expression, { kind: "literal", value: null });
    });
});

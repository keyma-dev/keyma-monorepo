import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { compile, compileVirtual } from "../src/compile.js";
import * as CODES from "../src/diagnostics.js";
import type { IRExpression, IRSchema, IRStatement } from "@keyma/ir";

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

/**
 * A getter is lowered to a behavior — an `IRMethod` with `kind: "getter"` whose body
 * is a single `return <expr>` — and lives in `schema.methods`, not `schema.fields`.
 * Return the lowered expression of a getter behavior by name.
 */
function getterExpr(schema: IRSchema | undefined, name: string): IRExpression | undefined {
    const m = (schema?.methods ?? []).find((mm) => mm.kind === "getter" && mm.name === name);
    const stmt = m?.statements[0];
    return stmt !== undefined && stmt.kind === "return" ? (stmt.value ?? undefined) : undefined;
}

/** Return the full lowered statement list of a getter behavior by name. */
function getterStatements(schema: IRSchema | undefined, name: string): IRStatement[] | undefined {
    return (schema?.methods ?? []).find((mm) => mm.kind === "getter" && mm.name === name)?.statements;
}

/** Extract the first arrow argument of an intrinsic expression (e.g. a filter/map predicate). */
function firstArrow(expr: IRExpression | undefined): Extract<IRExpression, { kind: "arrow" }> | undefined {
    if (expr === undefined || expr.kind !== "intrinsic") return undefined;
    const a = expr.args[0];
    return a !== undefined && a.kind === "arrow" ? a : undefined;
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

    for (const [getterName, expectedExpr] of Object.entries(snapshots)) {
        it(`lowers "${getterName}" to the correct IRExpression`, () => {
            assert.ok(schema !== undefined, "Product schema not found");
            const expr = getterExpr(schema, getterName);
            assert.ok(expr !== undefined, `getter "${getterName}" not found as a behavior`);
            assert.deepEqual(expr, expectedExpr, `IRExpression mismatch for "${getterName}"`);
        });
    }

    it("does not turn getters into schema fields", () => {
        assert.ok(schema !== undefined);
        for (const getterName of Object.keys(snapshots)) {
            assert.equal(
                schema.fields.find((f) => f.name === getterName),
                undefined,
                `getter "${getterName}" must not be a schema field`,
            );
        }
    });
});

// ─── KEYMA014 — unsupported getter body expressions ──────────────────────────

describe("KEYMA014 — unsupported getter body expressions", () => {
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

// ─── Multi-statement getter bodies (portable statement subset) ───────────────

describe("getters — multi-statement portable bodies", () => {
    it("lowers `const x = this.n; return x * 2`, resolving x as a local identifier", () => {
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
        assert.deepEqual(errorCodes(result), [], JSON.stringify(result.diagnostics));
        const foo = result.ir.schemas.find((s) => s.sourceName === "Foo");
        assert.deepEqual(getterStatements(foo, "doubled"), [
            { kind: "const", name: "x", init: { kind: "field", name: "n" } },
            {
                kind: "return",
                value: {
                    kind: "binary", op: "*",
                    left: { kind: "identifier", name: "x" }, // local, NOT { kind: "field" }
                    right: { kind: "literal", value: 2 },
                },
            },
        ]);
    });

    it("lowers an `if` with an early return", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    declare n: number;
                    @Computed() get sign(): string {
                        if (this.n < 0) {
                            return "neg";
                        }
                        return "pos";
                    }
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], JSON.stringify(result.diagnostics));
        const foo = result.ir.schemas.find((s) => s.sourceName === "Foo");
        assert.deepEqual(getterStatements(foo, "sign"), [
            {
                kind: "if",
                condition: { kind: "binary", op: "<", left: { kind: "field", name: "n" }, right: { kind: "literal", value: 0 } },
                consequent: [{ kind: "return", value: { kind: "literal", value: "neg" } }],
            },
            { kind: "return", value: { kind: "literal", value: "pos" } },
        ]);
    });

    it("rejects (KEYMA014) a body whose only path through an `if` has no reachable return", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    declare n: number;
                    @Computed() get sign(): number {
                        if (this.n < 0) {
                            const y = this.n;
                        }
                    }
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA014), `Expected KEYMA014. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("resolves an arrow param as a local, not a schema field (latent-bug fix)", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    declare tags: string[];
                    @Computed() get shortTags(): string[] {
                        return this.tags.filter(t => t.length < 3);
                    }
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], JSON.stringify(result.diagnostics));
        const foo = result.ir.schemas.find((s) => s.sourceName === "Foo");
        assert.deepEqual(getterExpr(foo, "shortTags"), {
            kind: "intrinsic", op: "array.filter",
            receiver: { kind: "field", name: "tags" },
            args: [{
                kind: "arrow", params: ["t"],
                body: {
                    kind: "binary", op: "<",
                    // t.length — receiver is the local `t`, NOT { kind: "field", name: "t" }
                    left: { kind: "intrinsic", op: "string.length", receiver: { kind: "identifier", name: "t" }, args: [] },
                    right: { kind: "literal", value: 3 },
                },
                returnType: { kind: "boolean" }, // inferred (Part 2)
            }],
        });
    });
});

// ─── Newly-supported getter expressions (unified portable engine) ─────────────

describe("getters — newly-supported portable expressions", () => {
    function lowered(src: string, getter: string): IRExpression | undefined {
        const result = cv({ "schema.ts": src });
        assert.deepEqual(errorCodes(result), [], `Unexpected errors: ${JSON.stringify(result.diagnostics)}`);
        const schema = result.ir.schemas.find((s) => s.sourceName === "Foo");
        return getterExpr(schema, getter);
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

// ─── New intrinsics: Math.*, String()/Number(), array.map/some/every ─────────

describe("intrinsics — Math, coercion, array map/some/every", () => {
    function lowered(src: string, getter: string): IRExpression | undefined {
        const result = cv({ "schema.ts": src });
        assert.deepEqual(errorCodes(result), [], `Unexpected errors: ${JSON.stringify(result.diagnostics)}`);
        return getterExpr(result.ir.schemas.find((s) => s.sourceName === "Foo"), getter);
    }

    it("lowers Math.round(...) to a free-standing math.round intrinsic", () => {
        const expr = lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                declare n: number;
                @Computed() get r(): number { return Math.round(this.n * 1.5); }
            }
        `, "r");
        assert.deepEqual(expr, {
            kind: "intrinsic", op: "math.round", receiver: null,
            args: [{ kind: "binary", op: "*", left: { kind: "field", name: "n" }, right: { kind: "literal", value: 1.5 } }],
        });
    });

    it("lowers variadic Math.min(...) with multiple args", () => {
        const expr = lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                declare a: number;
                declare b: number;
                @Computed() get m(): number { return Math.min(this.a, this.b, 0); }
            }
        `, "m");
        assert.deepEqual(expr, {
            kind: "intrinsic", op: "math.min", receiver: null,
            args: [{ kind: "field", name: "a" }, { kind: "field", name: "b" }, { kind: "literal", value: 0 }],
        });
    });

    it("rejects an unsupported Math method (KEYMA085)", () => {
        const r = cv({ "schema.ts": `
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                declare n: number;
                @Computed() get h(): number { return Math.hypot(this.n, 1); }
            }
        `});
        assert.ok(hasError(r, "KEYMA085"), JSON.stringify(r.diagnostics));
    });

    it("lowers String(x) to a to-string intrinsic", () => {
        const expr = lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                declare n: number;
                @Computed() get s(): string { return String(this.n); }
            }
        `, "s");
        assert.deepEqual(expr, { kind: "intrinsic", op: "to-string", receiver: null, args: [{ kind: "field", name: "n" }] });
    });

    it("lowers Number(x) to a to-number intrinsic", () => {
        const expr = lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                declare s: string;
                @Computed() get n(): number { return Number(this.s); }
            }
        `, "n");
        assert.deepEqual(expr, { kind: "intrinsic", op: "to-number", receiver: null, args: [{ kind: "field", name: "s" }] });
    });

    it("lowers array.map with an arrow whose param is a local identifier", () => {
        const expr = lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                declare tags: string[];
                @Computed() get lengths(): number[] { return this.tags.map(t => t.length); }
            }
        `, "lengths");
        assert.deepEqual(expr, {
            kind: "intrinsic", op: "array.map",
            receiver: { kind: "field", name: "tags" },
            args: [{
                kind: "arrow", params: ["t"],
                body: { kind: "intrinsic", op: "string.length", receiver: { kind: "identifier", name: "t" }, args: [] },
                returnType: { kind: "number" }, // inferred (Part 2)
            }],
        });
    });

    it("lowers array.some / array.every", () => {
        const some = lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                declare tags: string[];
                @Computed() get anyLong(): boolean { return this.tags.some(t => t.length > 5); }
            }
        `, "anyLong");
        assert.equal(some?.kind, "intrinsic");
        assert.equal((some as { op: string }).op, "array.some");

        const every = lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                declare nums: number[];
                @Computed() get allPos(): boolean { return this.nums.every(x => x > 0); }
            }
        `, "allPos");
        assert.equal((every as { op: string }).op, "array.every");
    });
});

// ─── Arrow block bodies + return-type inference (Part 2) ─────────────────────

describe("arrows — block bodies & return-type inference", () => {
    function lowered(src: string, getter: string): IRExpression | undefined {
        const result = cv({ "schema.ts": src });
        assert.deepEqual(errorCodes(result), [], `Unexpected errors: ${JSON.stringify(result.diagnostics)}`);
        return getterExpr(result.ir.schemas.find((s) => s.sourceName === "Foo"), getter);
    }

    it("lowers a genuinely multi-statement block-arrow predicate to `statements`", () => {
        const arrow = firstArrow(lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                declare tags: string[];
                @Computed() get longTrimmed(): string[] {
                    return this.tags.filter(x => { const t = x.trim(); return t.length > 3; });
                }
            }
        `, "longTrimmed"));
        assert.ok(arrow !== undefined);
        assert.equal(arrow.body, undefined);
        assert.deepEqual(arrow.statements, [
            { kind: "const", name: "t", init: { kind: "intrinsic", op: "string.trim", receiver: { kind: "identifier", name: "x" }, args: [] } },
            {
                kind: "return",
                value: {
                    kind: "binary", op: ">",
                    left: { kind: "intrinsic", op: "string.length", receiver: { kind: "identifier", name: "t" }, args: [] },
                    right: { kind: "literal", value: 3 },
                },
            },
        ]);
        assert.deepEqual(arrow.returnType, { kind: "boolean" });
    });

    it("normalizes a single-return block arrow `{ return e }` down to a concise `body`", () => {
        const arrow = firstArrow(lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                declare nums: number[];
                @Computed() get pos(): number[] {
                    return this.nums.filter(x => { return x > 0; });
                }
            }
        `, "pos"));
        assert.ok(arrow !== undefined);
        assert.equal(arrow.statements, undefined);
        assert.deepEqual(arrow.body, { kind: "binary", op: ">", left: { kind: "identifier", name: "x" }, right: { kind: "literal", value: 0 } });
        assert.deepEqual(arrow.returnType, { kind: "boolean" });
    });

    it("infers a string return type (`s => s.toUpperCase()`)", () => {
        const arrow = firstArrow(lowered(`
            import { Schema, Computed } from "@keyma/dsl";
            @Schema() class Foo {
                declare tags: string[];
                @Computed() get upper(): string[] { return this.tags.map(s => s.toUpperCase()); }
            }
        `, "upper"));
        assert.ok(arrow !== undefined);
        assert.deepEqual(arrow.returnType, { kind: "string" });
    });
});

// ─── Getters are behaviors, not fields ────────────────────────────────────────

describe("getters lower to behaviors, not schema fields", () => {
    it("lowers an undecorated getter as a getter behavior (no warning)", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/dsl";
                @Schema() class Foo {
                    declare first: string;
                    get shout(): string { return this.first; }
                }
            `,
        });
        assert.equal(errorCodes(result).length, 0, JSON.stringify(result.diagnostics));
        const foo = result.ir.schemas.find((s) => s.sourceName === "Foo");
        assert.equal(foo?.fields.find((f) => f.name === "shout"), undefined, "getter must not become a field");
        const m = (foo?.methods ?? []).find((mm) => mm.name === "shout");
        assert.ok(m !== undefined && m.kind === "getter", "getter should become a getter behavior");
        // An undecorated getter carries no deferred-feature decorator → no KEYMA098.
        assert.ok(!result.diagnostics.some((d) => d.code === CODES.KEYMA098));
    });

    it("warns (KEYMA098) on a @Computed getter but still emits it as a behavior", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/dsl";
                @Schema() class Foo {
                    declare first: string;
                    @Computed() get shout(): string { return this.first; }
                }
            `,
        });
        assert.equal(errorCodes(result).length, 0, JSON.stringify(result.diagnostics));
        const foo = result.ir.schemas.find((s) => s.sourceName === "Foo");
        assert.equal(foo?.fields.find((f) => f.name === "shout"), undefined, "@Computed getter must not be a field");
        const m = (foo?.methods ?? []).find((mm) => mm.name === "shout");
        assert.ok(m !== undefined && m.kind === "getter");
        assert.ok(
            result.diagnostics.some((d) => d.code === CODES.KEYMA098 && d.severity === "warning"),
            "expected a KEYMA098 deferral warning",
        );
    });

    it("warns (KEYMA098) on an @Indexed getter", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed, Indexed } from "@keyma/dsl";
                @Schema() class Foo {
                    declare first: string;
                    @Indexed() @Computed() get shout(): string { return this.first; }
                }
            `,
        });
        assert.equal(errorCodes(result).length, 0, JSON.stringify(result.diagnostics));
        assert.ok(result.diagnostics.some((d) => d.code === CODES.KEYMA098 && d.severity === "warning"));
    });

    it("errors (KEYMA019) when @Computed() is applied to a plain property", () => {
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

// ─── Getter/setter pairs ──────────────────────────────────────────────────────

describe("getter/setter pair — both are behaviors", () => {
    it("allows a getter/setter pair of the same name (accessor pair)", () => {
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
        assert.equal(errorCodes(result).length, 0, JSON.stringify(result.diagnostics));

        const foo = result.ir.schemas.find((s) => s.sourceName === "Foo")!;
        assert.equal(foo.fields.find((f) => f.name === "name"), undefined, "getter must not be a field");

        const getter = (foo.methods ?? []).find((m) => m.name === "name" && m.kind === "getter");
        assert.ok(getter !== undefined, "getter should become a behavior");

        const setter = (foo.methods ?? []).find((m) => m.name === "name" && m.kind === "setter");
        assert.ok(setter !== undefined, "setter should become a behavior");
        assert.equal(setter!.statements[0]!.kind, "assign");
    });

    it("rejects two getters of the same name (KEYMA040)", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/dsl";
                @Schema() class Foo {
                    declare a: string;
                    get dup(): string { return this.a; }
                    get dup(): string { return this.a; }
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA040), `Expected KEYMA040. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("rejects a getter that collides with a stored field (KEYMA040)", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/dsl";
                @Schema() class Foo {
                    declare name: string;
                    get name(): string { return "x"; }
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA040), `Expected KEYMA040. Got: ${JSON.stringify(result.diagnostics)}`);
    });

    it("compiles a getter without a setter", () => {
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
        assert.deepEqual(getterExpr(schema, "nothing"), { kind: "literal", value: null });
    });
});

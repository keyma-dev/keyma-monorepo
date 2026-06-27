import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { compile, compileVirtual } from "./harness.js";
import * as CODES from "../../src/frontend-ts/diagnostics.js";
import type { IRExpression, IRClassDeclaration } from "@keyma/core/ir";

// The generic portable expression/statement engine (intrinsics, Math/coercion, arrays, arrows,
// multi-statement getter bodies, KEYMA014, null literal) is domain-neutral and now lives in
// @keyma/compiler's frontend-ts/expression.test.ts. What remains here is schema-specific: getters
// lower to behaviors (not fields), the `@Computed` deferral warning, and the golden expression
// snapshot over a `@Computed`-decorated fixture.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.join(__dirname, "..", "..", "..", "test", "frontend-ts", "fixtures");
const SNAPSHOTS = path.join(__dirname, "..", "..", "..", "test", "frontend-ts", "snapshots");

function fixture(name: string): string {
    return path.join(FIXTURES, name);
}

const VIRTUAL_BASE = path.join(__dirname, "..", "..", "..", "src", "frontend-ts");

function cv(sources: Record<string, string>) {
    return compileVirtual(sources, { baseDir: VIRTUAL_BASE });
}

function errorCodes(result: ReturnType<typeof compile>): string[] {
    return result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

/**
 * A getter is lowered to a behavior — an `IRMethod` with `kind: "getter"` whose body is a single
 * `return <expr>` — and lives in `schema.methods`, not `schema.fields`. Return the lowered
 * expression of a getter behavior by name.
 */
function getterExpr(schema: IRClassDeclaration | undefined, name: string): IRExpression | undefined {
    const m = (schema?.methods ?? []).find((mm) => mm.kind === "getter" && mm.name === name);
    const stmt = m?.statements[0];
    return stmt !== undefined && stmt.kind === "return" ? (stmt.value ?? undefined) : undefined;
}

// ─── Snapshot tests for every supported expression kind (over a @Computed fixture) ───────────

describe("expression lowering — snapshot", () => {
    const result = compile({ files: [fixture("computed-extended.ts")] });

    const rawSnapshot = readFileSync(path.join(SNAPSHOTS, "computed-expressions.json"), "utf-8");
    const snapshots = JSON.parse(rawSnapshot) as Record<string, IRExpression>;

    it("produces no errors on the extended fixture", () => {
        assert.deepEqual(errorCodes(result), [], `Unexpected errors: ${JSON.stringify(result.diagnostics)}`);
    });

    const schema = result.ir.classes.find((s) => s.sourceName === "Product");

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

// ─── Getters are behaviors, not fields (+ @Computed deferral) ─────────────────────────────────

describe("getters lower to behaviors, not schema fields", () => {
    it("lowers an undecorated getter as a getter behavior (no warning)", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema() class Foo {
                    declare first: string;
                    get shout(): string { return this.first; }
                }
            `,
        });
        assert.equal(errorCodes(result).length, 0, JSON.stringify(result.diagnostics));
        const foo = result.ir.classes.find((s) => s.sourceName === "Foo");
        assert.equal(foo?.fields.find((f) => f.name === "shout"), undefined, "getter must not become a field");
        const m = (foo?.methods ?? []).find((mm) => mm.name === "shout");
        assert.ok(m !== undefined && m.kind === "getter", "getter should become a getter behavior");
        // An undecorated getter carries no deferred-feature decorator → no KEYMA098.
        assert.ok(!result.diagnostics.some((d) => d.code === CODES.KEYMA098));
    });

    it("warns (KEYMA098) on a @Computed getter but still emits it as a behavior", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/schema/dsl";
                @Schema() class Foo {
                    declare first: string;
                    @Computed() get shout(): string { return this.first; }
                }
            `,
        });
        assert.equal(errorCodes(result).length, 0, JSON.stringify(result.diagnostics));
        const foo = result.ir.classes.find((s) => s.sourceName === "Foo");
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
                import { Schema, Computed, Indexed } from "@keyma/schema/dsl";
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
                import { Schema, Computed } from "@keyma/schema/dsl";
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
                import { Schema, Computed } from "@keyma/schema/dsl";
                @Schema() class Foo {
                    declare firstName: string;
                    @Computed() get name(): string { return this.firstName; }
                    set name(v: string) { this.firstName = v; }
                }
            `,
        });
        assert.equal(errorCodes(result).length, 0, JSON.stringify(result.diagnostics));

        const foo = result.ir.classes.find((s) => s.sourceName === "Foo")!;
        assert.equal(foo.fields.find((f) => f.name === "name"), undefined, "getter must not be a field");

        const getter = (foo.methods ?? []).find((m) => m.name === "name" && m.kind === "getter");
        assert.ok(getter !== undefined, "getter should become a behavior");

        const setter = (foo.methods ?? []).find((m) => m.name === "name" && m.kind === "setter");
        assert.ok(setter !== undefined, "setter should become a behavior");
        assert.equal(setter!.statements[0]!.kind, "assign");
    });

    it("compiles a getter without a setter", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Computed } from "@keyma/schema/dsl";
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

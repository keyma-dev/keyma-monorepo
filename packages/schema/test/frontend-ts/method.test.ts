import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual } from "./harness.js";
import * as CODES from "../../src/frontend-ts/diagnostics.js";
import type { IRMethod, IRStatement } from "@keyma/core/ir";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VIRTUAL_BASE = path.join(__dirname, "..", "..", "..", "src", "frontend-ts");

function cv(sources: Record<string, string>) {
    return compileVirtual(sources, { baseDir: VIRTUAL_BASE });
}

function errorCodes(result: ReturnType<typeof cv>): string[] {
    return result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

function hasError(result: ReturnType<typeof cv>, code: string): boolean {
    return result.diagnostics.some((d) => d.code === code && d.severity === "error");
}

function methodsOf(result: ReturnType<typeof cv>, sourceName: string): IRMethod[] {
    const s = result.ir.classes.find((s) => s.sourceName === sourceName);
    assert.ok(s !== undefined, `schema ${sourceName} not found`);
    return s!.methods ?? [];
}

describe("methods — portable instance method behaviors", () => {
    it("lowers a method with params, return type, and a portable body", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema() class Foo {
                    declare firstName: string;
                    greeting(prefix: string): string {
                        return \`\${prefix} \${this.firstName.toUpperCase()}\`;
                    }
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], JSON.stringify(result.diagnostics));
        const methods = methodsOf(result, "Foo");
        assert.equal(methods.length, 1);
        const m = methods[0]!;
        assert.equal(m.name, "greeting");
        assert.equal(m.kind, "method");
        assert.deepEqual(m.params, [{ name: "prefix", type: { kind: "string" } }]);
        assert.deepEqual(m.returnType, { kind: "string" });
        assert.equal(m.visibility, "public");
        assert.equal(m.statements[0]!.kind, "return");
    });

    it("treats a `void` method as having no return type", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema() class Foo {
                    declare count: number;
                    touch(): void { this.count = this.count; }
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], JSON.stringify(result.diagnostics));
        const m = methodsOf(result, "Foo")[0]!;
        assert.equal(m.returnType, undefined);
    });

    it("marks a private method's visibility as private", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema() class Foo {
                    declare x: string;
                    private secret(): string { return this.x; }
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], JSON.stringify(result.diagnostics));
        assert.equal(methodsOf(result, "Foo")[0]!.visibility, "private");
    });

    it("requires explicit parameter and return types (KEYMA092)", () => {
        const missingReturn = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema() class Foo { declare x: string; m() { return this.x; } }
            `,
        });
        assert.ok(hasError(missingReturn, CODES.KEYMA092), JSON.stringify(missingReturn.diagnostics));

        const missingParam = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema() class Foo { declare x: string; m(p): string { return this.x; } }
            `,
        });
        assert.ok(hasError(missingParam, CODES.KEYMA092), JSON.stringify(missingParam.diagnostics));
    });

    it("lowers an async method (async=true, peels Promise<T>, lowers await) — async is now a supported marker", () => {
        // Async methods are no longer rejected (KEYMA082): the compiler now lowers them with an
        // `async` marker, peeling Promise<T> off the return type and lowering `await` in the body
        // (see @keyma/compiler's authoritative frontend-ts/async.test.ts).
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema() class Foo { declare x: string; async load(): Promise<string> { return await Promise.resolve(this.x); } }
            `,
        });
        assert.deepEqual(errorCodes(result), [], JSON.stringify(result.diagnostics));
        const m = methodsOf(result, "Foo")[0]!;
        assert.equal(m.name, "load");
        assert.equal(m.async, true);
        assert.deepEqual(m.returnType, { kind: "string" });
        assert.equal(m.statements[0]!.kind, "return");
    });

    it("rejects a method whose name collides with a field (KEYMA040)", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema() class Foo {
                    declare name: string;
                    name(): string { return this.name; }
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA040), JSON.stringify(result.diagnostics));
    });
});

describe("setters — portable virtual-property behaviors", () => {
    it("lowers a setter to an assign-statement behavior", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema() class Foo {
                    declare email: string;
                    set primaryEmail(value: string) { this.email = value.trim(); }
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], JSON.stringify(result.diagnostics));
        const m = methodsOf(result, "Foo")[0]!;
        assert.equal(m.kind, "setter");
        assert.equal(m.name, "primaryEmail");
        assert.deepEqual(m.params, [{ name: "value", type: { kind: "string" } }]);
        const stmt = m.statements[0] as Extract<IRStatement, { kind: "assign" }>;
        assert.equal(stmt.kind, "assign");
        assert.deepEqual(stmt.target, { kind: "field", name: "email" });
        assert.equal(stmt.value.kind, "intrinsic");
    });

    it("allows a setter to share a name with a field (get/set or stored field)", () => {
        const result = cv({
            "schema.ts": `
                import { Schema } from "@keyma/schema/dsl";
                @Schema() class Foo {
                    declare name: string;
                    set name(value: string) { this.name = value; }
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], JSON.stringify(result.diagnostics));
        assert.equal(methodsOf(result, "Foo").length, 1);
    });
});

describe("assignment is gated to behavior bodies", () => {
    it("rejects assignment inside a validator body", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Validate } from "@keyma/schema/dsl";
                import type { ValidatorFn } from "@keyma/schema/dsl";
                export function mutate(): ValidatorFn<string> {
                    return (value, field, ctx) => {
                        value = "x";
                        return null;
                    };
                }
                @Schema() class Foo {
                    @Validate(mutate())
                    declare x: string;
                }
            `,
        });
        // Assignment is not part of the validator/formatter portable subset.
        assert.ok(hasError(result, CODES.KEYMA082), JSON.stringify(result.diagnostics));
    });
});

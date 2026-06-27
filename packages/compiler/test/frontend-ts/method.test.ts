import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRDiagnostic, IRStatement } from "@keyma/core/ir";
import { lowerMethod, lowerSetter, KEYMA092 } from "../../src/frontend-ts/index.js";
import { build, methodCtx, findClass, classMethod, classSetter, hasCode } from "./_helpers.js";

// Plain instance methods + setters lower to portable behaviors. (Async methods and the
// generator rejection live in async.test.ts; constructors/destructors in constructor-destructor.)

describe("methods — portable instance behaviors", () => {
    it("lowers params, return type, and a portable body", () => {
        const b = build(`
            class Foo {
                firstName!: string;
                greeting(prefix: string): string { return \`\${prefix} \${this.firstName.toUpperCase()}\`; }
            }
        `);
        const diags: IRDiagnostic[] = [];
        const m = lowerMethod(classMethod(findClass(b.sf, "Foo"), "greeting"), "greeting", "public", methodCtx(b, diags));
        assert.equal(diags.length, 0, JSON.stringify(diags));
        assert.ok(m);
        assert.equal(m!.name, "greeting");
        assert.equal(m!.kind, "method");
        assert.deepEqual(m!.params, [{ name: "prefix", type: { kind: "string" } }]);
        assert.deepEqual(m!.returnType, { kind: "string" });
        assert.equal(m!.visibility, "public");
        assert.equal(m!.statements[0]!.kind, "return");
    });

    it("treats a `void` method as having no return type", () => {
        const b = build(`class Foo { count!: number; touch(): void { this.count = this.count; } }`);
        const diags: IRDiagnostic[] = [];
        const m = lowerMethod(classMethod(findClass(b.sf, "Foo"), "touch"), "touch", "public", methodCtx(b, diags));
        assert.equal(diags.length, 0, JSON.stringify(diags));
        assert.ok(m);
        assert.equal("returnType" in m!, false);
        assert.equal(m!.statements[0]!.kind, "assign");
    });

    it("carries the supplied visibility", () => {
        const b = build(`class Foo { x!: string; secret(): string { return this.x; } }`);
        const diags: IRDiagnostic[] = [];
        const m = lowerMethod(classMethod(findClass(b.sf, "Foo"), "secret"), "secret", "private", methodCtx(b, diags));
        assert.ok(m);
        assert.equal(m!.visibility, "private");
    });

    it("requires an explicit return type (KEYMA092)", () => {
        const b = build(`class Foo { x!: string; m() { return this.x; } }`);
        const diags: IRDiagnostic[] = [];
        const m = lowerMethod(classMethod(findClass(b.sf, "Foo"), "m"), "m", "public", methodCtx(b, diags));
        assert.equal(m, null);
        assert.ok(hasCode(diags, KEYMA092), JSON.stringify(diags));
    });

    it("requires an explicit parameter type (KEYMA092)", () => {
        const b = build(`class Foo { x!: string; m(p): string { return this.x; } }`);
        const diags: IRDiagnostic[] = [];
        const m = lowerMethod(classMethod(findClass(b.sf, "Foo"), "m"), "m", "public", methodCtx(b, diags));
        assert.equal(m, null);
        assert.ok(hasCode(diags, KEYMA092), JSON.stringify(diags));
    });
});

describe("setters — portable virtual-property behaviors", () => {
    it("lowers a setter to an assign-statement behavior", () => {
        const b = build(`class Foo { email!: string; set primaryEmail(value: string) { this.email = value.trim(); } }`);
        const diags: IRDiagnostic[] = [];
        const m = lowerSetter(classSetter(findClass(b.sf, "Foo"), "primaryEmail"), "primaryEmail", "public", methodCtx(b, diags));
        assert.equal(diags.length, 0, JSON.stringify(diags));
        assert.ok(m);
        assert.equal(m!.kind, "setter");
        assert.equal(m!.name, "primaryEmail");
        assert.deepEqual(m!.params, [{ name: "value", type: { kind: "string" } }]);
        const stmt = m!.statements[0] as Extract<IRStatement, { kind: "assign" }>;
        assert.equal(stmt.kind, "assign");
        assert.deepEqual(stmt.target, { kind: "field", name: "email" });
        assert.equal(stmt.value.kind, "intrinsic");
    });
});

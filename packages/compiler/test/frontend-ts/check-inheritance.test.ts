import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRClassDeclaration, IRMember, IRType, IRDiagnostic } from "@keyma/core/ir";
import { checkInheritance, KEYMA032, KEYMA033, KEYMA034 } from "../../src/frontend-ts/index.js";

// Inheritance validation reads only the domain-neutral core IR (`extends`, field types,
// visibility), so it is exercised by constructing classes directly — no `@Schema` in the loop.

const loc = { file: "t.ts", line: 1, column: 1 };

function field(name: string, type: IRType, extra: Partial<IRMember> = {}): IRMember {
    return { name, type, visibility: "public", readonly: false, required: true, source: loc, ...extra };
}

function cls(sourceName: string, fields: IRMember[], extra: Partial<IRClassDeclaration> = {}): IRClassDeclaration {
    return { name: sourceName.toLowerCase(), sourceName, visibility: "public", fields, source: loc, ...extra };
}

function check(classes: IRClassDeclaration[]): IRDiagnostic[] {
    const diagnostics: IRDiagnostic[] = [];
    const map = new Map(classes.map((c) => [c.sourceName, c]));
    checkInheritance(classes, { classes: map, diagnostics });
    return diagnostics;
}

const hasError = (diags: IRDiagnostic[], code: string) => diags.some((d) => d.code === code && d.severity === "error");

describe("KEYMA034 — field override compatibility", () => {
    function overrides(parent: IRMember, child: IRMember): IRDiagnostic[] {
        const base = cls("Base", [parent], { name: "base" });
        const derived = cls("Child", [child], { name: "child", extends: "Base" });
        return check([base, derived]);
    }

    const num: IRType = { kind: "number" };
    const str: IRType = { kind: "string" };
    const enumAbc: IRType = { kind: "enum", values: ["a", "b", "c"] };
    const enumAb: IRType = { kind: "enum", values: ["a", "b"] };

    it("allows number → number", () => {
        assert.ok(!hasError(overrides(field("x", num), field("x", num)), KEYMA034));
    });

    it("allows narrowing string | null → string (drop null)", () => {
        assert.ok(!hasError(overrides(field("x", str, { nullable: true }), field("x", str)), KEYMA034));
    });

    it("allows an enum subset override", () => {
        assert.ok(!hasError(overrides(field("x", enumAbc), field("x", enumAb)), KEYMA034));
    });

    it("rejects an unrelated type override (string → number)", () => {
        assert.ok(hasError(overrides(field("x", str), field("x", num)), KEYMA034));
    });

    it("rejects widening string → string | null (add null)", () => {
        assert.ok(hasError(overrides(field("x", str), field("x", str, { nullable: true })), KEYMA034));
    });

    it("rejects an enum superset override", () => {
        assert.ok(hasError(overrides(field("x", enumAb), field("x", enumAbc)), KEYMA034));
    });
});

describe("KEYMA032 — public class extends private parent", () => {
    it("flags a public child extending a private parent", () => {
        const base = cls("Base", [field("id", { kind: "id" })], { name: "base", visibility: "private" });
        const child = cls("Child", [field("extra", { kind: "string" })], { name: "child", extends: "Base" });
        assert.ok(hasError(check([base, child]), KEYMA032));
    });

    it("does not flag a private child extending a private parent", () => {
        const base = cls("Base", [field("id", { kind: "id" })], { name: "base", visibility: "private" });
        const child = cls("Child", [field("extra", { kind: "string" })], {
            name: "child",
            visibility: "private",
            extends: "Base",
        });
        assert.ok(!hasError(check([base, child]), KEYMA032));
    });
});

describe("KEYMA033 — extends a non-lowered parent", () => {
    it("flags an `extends` link to a class absent from the lowered set (e.g. vendor/ambient)", () => {
        const child = cls("Child", [field("extra", { kind: "string" })], { name: "child", extends: "VendorBase" });
        assert.ok(hasError(check([child]), KEYMA033));
    });
});

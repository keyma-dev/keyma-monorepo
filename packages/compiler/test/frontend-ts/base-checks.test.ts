import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRClassDeclaration, IRMember, IRType, IRDiagnostic } from "@keyma/core/ir";
import {
    checkDuplicateNames,
    checkVisibilityLeaks,
    checkPublicSurface,
    KEYMA001,
    KEYMA031,
    KEYMA037,
} from "../../src/frontend-ts/index.js";

// Base-language validation runs over the domain-neutral core IR (class names, visibility, and the
// reference/embedded type kinds) — no domain extension slice is read — so these checks are tested
// by constructing IR classes directly, with no `@Schema` discovery in the loop.

const loc = { file: "t.ts", line: 1, column: 1 };

function field(name: string, extra: Partial<IRMember> = {}): IRMember {
    return {
        name,
        type: { kind: "string" } as IRType,
        visibility: "public",
        readonly: false,
        required: true,
        source: loc,
        ...extra,
    };
}

function cls(
    sourceName: string,
    fields: IRMember[],
    extra: Partial<IRClassDeclaration> = {},
): IRClassDeclaration {
    return { name: sourceName.toLowerCase(), sourceName, visibility: "public", fields, source: loc, ...extra };
}

function run(check: (cs: IRClassDeclaration[], d: IRDiagnostic[]) => void, classes: IRClassDeclaration[]): IRDiagnostic[] {
    const diags: IRDiagnostic[] = [];
    check(classes, diags);
    return diags;
}

const hasError = (diags: IRDiagnostic[], code: string) =>
    diags.some((d) => d.code === code && d.severity === "error");

describe("KEYMA001 — duplicate class name", () => {
    it("flags two classes sharing the same canonical name", () => {
        const a = cls("UserA", [], { name: "user" });
        const b = cls("UserB", [], { name: "user" });
        assert.ok(hasError(run(checkDuplicateNames, [a, b]), KEYMA001));
    });

    it("does not flag distinct names", () => {
        const a = cls("UserA", [], { name: "usera" });
        const b = cls("UserB", [], { name: "userb" });
        assert.deepEqual(run(checkDuplicateNames, [a, b]), []);
    });
});

describe("KEYMA031 — public class leaks a private class", () => {
    const secret = cls("Secret", [field("token")], { name: "secret", visibility: "private" });

    it("flags a public reference/embedded field pointing at a private class", () => {
        const reference = cls("Public", [field("secret", { type: { kind: "reference", target: "Secret" } })]);
        assert.ok(hasError(run(checkVisibilityLeaks, [secret, reference]), KEYMA031));

        const embedded = cls("Public", [field("secret", { type: { kind: "embedded", target: "Secret" } })]);
        assert.ok(hasError(run(checkVisibilityLeaks, [secret, embedded]), KEYMA031));
    });

    it("does not flag when the exposing field is itself private", () => {
        const pub = cls("Public", [
            field("secret", { visibility: "private", type: { kind: "reference", target: "Secret" } }),
        ]);
        assert.ok(!hasError(run(checkVisibilityLeaks, [secret, pub]), KEYMA031));
    });

    it("does not flag when the target class is public", () => {
        const target = cls("Target", [field("x")]);
        const pub = cls("Public", [field("t", { type: { kind: "reference", target: "Target" } })]);
        assert.ok(!hasError(run(checkVisibilityLeaks, [target, pub]), KEYMA031));
    });

    it("does not flag a private class that leaks another private class", () => {
        const leaker = cls("Leaker", [field("secret", { type: { kind: "reference", target: "Secret" } })], {
            visibility: "private",
        });
        assert.ok(!hasError(run(checkVisibilityLeaks, [secret, leaker]), KEYMA031));
    });
});

describe("KEYMA037 — public class has only private fields", () => {
    it("flags a public class where every field is private", () => {
        const token = cls("Token", [field("value", { visibility: "private" }), field("refreshedAt", { visibility: "private" })]);
        assert.ok(hasError(run(checkPublicSurface, [token]), KEYMA037));
    });

    it("does not flag when at least one field is public", () => {
        const user = cls("User", [field("id"), field("passwordHash", { visibility: "private" })]);
        assert.ok(!hasError(run(checkPublicSurface, [user]), KEYMA037));
    });

    it("does not flag a private class whose fields are all private", () => {
        const token = cls("Token", [field("value", { visibility: "private" })], { visibility: "private" });
        assert.ok(!hasError(run(checkPublicSurface, [token]), KEYMA037));
    });

    it("exempts a fieldless public class", () => {
        const marker = cls("Marker", []);
        assert.ok(!hasError(run(checkPublicSurface, [marker]), KEYMA037));
    });

    it("a child with only private own fields passes if it inherits a public field", () => {
        const base = cls("Base", [field("id")], { name: "base" });
        const child = cls("Child", [field("secret", { visibility: "private" })], { name: "child", extends: "Base" });
        assert.ok(!hasError(run(checkPublicSurface, [base, child]), KEYMA037));
    });
});

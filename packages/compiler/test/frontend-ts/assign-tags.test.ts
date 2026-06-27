import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assignTags, stripTagHints, type RawTaggedField } from "src/frontend-ts/index.js";
import type { IRClassDeclaration } from "@keyma/core/ir";

const loc = { file: "t.ts", line: 1, column: 1 };

function field(name: string, extra: Partial<RawTaggedField> = {}): RawTaggedField {
    return {
        name,
        type: { kind: "string" },
        visibility: "public",
        readonly: false,
        required: true,
        source: loc,
        ...extra,
    };
}

function schema(name: string, fields: RawTaggedField[]): IRClassDeclaration {
    return { name, sourceName: name, visibility: "public", fields, source: loc };
}

function tagsOf(s: IRClassDeclaration): Record<string, number | undefined> {
    const o: Record<string, number | undefined> = {};
    for (const f of s.fields) o[f.name] = f.tag;
    return o;
}

const errorsOf = (ds: { code: string; severity: string }[]) => ds.filter((d) => d.severity === "error");

describe("assignTags", () => {
    it("bootstraps tags 1,2,3,… in declaration order", () => {
        const s = schema("User", [field("id"), field("email"), field("name")]);
        const { manifest, diagnostics } = assignTags(undefined, [s], { acceptTags: false });
        assert.deepEqual(tagsOf(s), { id: 1, email: 2, name: 3 });
        assert.equal(diagnostics.length, 0);
        assert.deepEqual(manifest.schemas["User"], { nextTag: 4, fields: { id: 1, email: 2, name: 3 }, tombstones: [] });
    });

    it("is idempotent — recompiling an unchanged schema keeps the same tags", () => {
        const prev = assignTags(undefined, [schema("User", [field("id"), field("email"), field("name")])], { acceptTags: false }).manifest;
        const s = schema("User", [field("id"), field("email"), field("name")]);
        const { diagnostics } = assignTags(prev, [s], { acceptTags: false });
        assert.deepEqual(tagsOf(s), { id: 1, email: 2, name: 3 });
        assert.equal(diagnostics.length, 0);
    });

    it("allocates a fresh tag for a new field (additive, automatic)", () => {
        const prev = assignTags(undefined, [schema("User", [field("id"), field("email")])], { acceptTags: false }).manifest;
        const s = schema("User", [field("id"), field("email"), field("age")]);
        const { manifest, diagnostics } = assignTags(prev, [s], { acceptTags: false });
        assert.deepEqual(tagsOf(s), { id: 1, email: 2, age: 3 });
        assert.equal(errorsOf(diagnostics).length, 0);
        assert.equal(manifest.schemas["User"]!.nextTag, 4);
    });

    it("tombstones a removed field (pure removal is automatic)", () => {
        const prev = assignTags(undefined, [schema("User", [field("id"), field("email"), field("name")])], { acceptTags: false }).manifest;
        const s = schema("User", [field("id"), field("email")]);
        const { manifest, diagnostics } = assignTags(prev, [s], { acceptTags: false });
        assert.deepEqual(tagsOf(s), { id: 1, email: 2 });
        assert.equal(errorsOf(diagnostics).length, 0);
        assert.deepEqual(manifest.schemas["User"]!.tombstones, [3]);
    });

    it("@RenamedFrom carries a field's tag across a rename (no tombstone, no drift)", () => {
        const prev = assignTags(undefined, [schema("User", [field("id"), field("email"), field("name")])], { acceptTags: false }).manifest;
        const s = schema("User", [field("id"), field("emailAddress", { renamedFrom: "email" }), field("name")]);
        const { manifest, diagnostics } = assignTags(prev, [s], { acceptTags: false });
        assert.deepEqual(tagsOf(s), { id: 1, emailAddress: 2, name: 3 });
        assert.equal(diagnostics.length, 0);
        assert.ok(!("renamedFrom" in s.fields[1]!), "renamedFrom hint should be consumed");
        assert.deepEqual(manifest.schemas["User"]!.tombstones, []);
    });

    it("flags an un-hinted rename as KEYMA100 drift, unless --accept-tags", () => {
        const prev = assignTags(undefined, [schema("User", [field("id"), field("email"), field("name")])], { acceptTags: false }).manifest;

        const blocked = assignTags(prev, [schema("User", [field("id"), field("emailAddress"), field("name")])], { acceptTags: false });
        assert.ok(blocked.diagnostics.some((d) => d.code === "KEYMA100" && d.severity === "error"));

        // Accepted: the removal+add is applied as additive — old tag tombstoned, new tag allocated.
        const s = schema("User", [field("id"), field("emailAddress"), field("name")]);
        const accepted = assignTags(prev, [s], { acceptTags: true });
        assert.equal(errorsOf(accepted.diagnostics).length, 0);
        assert.deepEqual(tagsOf(s), { id: 1, emailAddress: 4, name: 3 });
        assert.deepEqual(accepted.manifest.schemas["User"]!.tombstones, [2]);
    });

    it("pins an explicit @Tag and routes the allocator around it", () => {
        const s = schema("Post", [field("id", { tag: 5 }), field("title")]);
        const { manifest, diagnostics } = assignTags(undefined, [s], { acceptTags: false });
        assert.deepEqual(tagsOf(s), { id: 5, title: 6 });
        assert.equal(diagnostics.length, 0);
        assert.equal(manifest.schemas["Post"]!.nextTag, 7);
    });

    it("KEYMA101 — @RenamedFrom names a field absent from the manifest", () => {
        const prev = assignTags(undefined, [schema("User", [field("id"), field("email")])], { acceptTags: false }).manifest;
        const s = schema("User", [field("id"), field("email"), field("x", { renamedFrom: "ghost" })]);
        const { diagnostics } = assignTags(prev, [s], { acceptTags: true });
        assert.ok(diagnostics.some((d) => d.code === "KEYMA101"));
    });

    it("KEYMA103 — two fields pin the same @Tag", () => {
        const s = schema("P", [field("a", { tag: 3 }), field("b", { tag: 3 })]);
        const { diagnostics } = assignTags(undefined, [s], { acceptTags: false });
        assert.ok(diagnostics.some((d) => d.code === "KEYMA103"));
    });

    it("never reuses a tombstoned tag for a new field", () => {
        // Remove name (tag 3 → tombstone), then add two fields: neither may reclaim tag 3.
        const prev = assignTags(undefined, [schema("U", [field("id"), field("email"), field("name")])], { acceptTags: false }).manifest;
        const s = schema("U", [field("id"), field("email"), field("a"), field("b")]);
        const { manifest } = assignTags(prev, [s], { acceptTags: true });
        const f = manifest.schemas["U"]!.fields;
        assert.equal(f["a"], 4);
        assert.equal(f["b"], 5);
        assert.deepEqual(manifest.schemas["U"]!.tombstones, [3]);
    });

    it("stripTagHints removes tag + renamedFrom (binary disabled path)", () => {
        const s = schema("Q", [field("a", { tag: 5, renamedFrom: "old" })]);
        stripTagHints([s]);
        assert.ok(!("tag" in s.fields[0]!));
        assert.ok(!("renamedFrom" in s.fields[0]!));
    });
});

/**
 * Defaults, computed getters/setters, standalone setters, instance methods and
 * materializers — exercised against the generated server bundle exactly as a
 * consumer would: construct classes with `new`, call the runtime `applyDefaults`
 * / `applyMaterializers`, and invoke the emitted `materializeX` helpers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyDefaults, applyMaterializers } from "@keyma/runtime-js";
import {
    Author,
    Post,
    materializeAuthor,
    materializePost,
} from "./setup.ts";

describe("applyDefaults — literal + expression defaults", () => {
    it("fills Author defaults (theme, role) and expression dates", () => {
        const out = applyDefaults(Author.schema, {});
        assert.equal(out.theme, "system", "literal string default applied");
        assert.equal(out.role, "viewer", "enum literal default applied");
        assert.ok(out.createdAt instanceof Date, "expression default Now() for createdAt");
        assert.ok(out.updatedAt instanceof Date, "expression default Now() for updatedAt");
    });

    it("fills Post defaults (status, rating, views, readingMinutes) and dates", () => {
        const out = applyDefaults(Post.schema, {});
        assert.equal(out.status, "draft", "enum literal default applied");
        assert.equal(out.rating, 0, "numeric literal default applied");
        assert.equal(out.views, 0, "numeric literal default applied");
        assert.equal(out.readingMinutes, 1, "numeric literal default applied");
        assert.ok(out.createdAt instanceof Date, "expression default Now() for createdAt");
        assert.ok(out.updatedAt instanceof Date, "expression default Now() for updatedAt");
    });

    it("does not override a provided value", () => {
        const out = applyDefaults(Author.schema, { theme: "dark" });
        assert.equal(out.theme, "dark", "provided value wins over the literal default");
        // sanity: the other defaults still fill in around it
        assert.equal(out.role, "viewer");
    });

    it("mutates and returns the same object", () => {
        const input: Record<string, unknown> = {};
        const out = applyDefaults(Author.schema, input);
        assert.equal(out, input, "applyDefaults returns the mutated input object");
    });
});

describe("computed getters + instance behavior", () => {
    it("Author.fullName getter joins firstName + lastName", () => {
        const a = new Author({ firstName: "Ada", lastName: "Lovelace" });
        assert.equal(a.fullName, "Ada Lovelace");
    });

    it("Author.fullName setter writes through to firstName", () => {
        const a = new Author({ firstName: "Ada", lastName: "Lovelace" });
        a.fullName = "Zed";
        assert.equal(a.firstName, "Zed", "setter assigns the value to firstName");
    });

    it("standalone primaryEmail setter trims and stores onto email", () => {
        const a = new Author({ firstName: "Ada", lastName: "Lovelace" });
        a.primaryEmail = "  X@Y.com  ";
        assert.equal(a.email, "X@Y.com", "setter trims and writes to email");
    });

    it("greeting() instance method uppercases firstName", () => {
        const a = new Author({ firstName: "ada" });
        assert.equal(a.greeting("Hi"), "Hi ADA");
    });

    it("Post.summary getter interpolates title + status", () => {
        const p = new Post({ title: "My Title", status: "published" });
        assert.equal(p.summary, "My Title (published)");
    });
});

describe("materializers — set computed fields on plain objects", () => {
    it("materializeAuthor sets fullName", () => {
        const o: Record<string, unknown> = { firstName: "Grace", lastName: "Hopper" };
        materializeAuthor(o);
        assert.equal(o.fullName, "Grace Hopper");
    });

    it("materializePost sets summary", () => {
        const p: Record<string, unknown> = { title: "T", status: "draft" };
        materializePost(p);
        assert.equal(p.summary, "T (draft)");
    });

    it("applyMaterializers runs a materializer array onto a plain object", () => {
        const o2: Record<string, unknown> = { firstName: "Grace", lastName: "Hopper" };
        applyMaterializers([materializeAuthor], o2);
        assert.equal(o2.fullName, "Grace Hopper");
    });

    it("applyMaterializers can run multiple materializers", () => {
        const o3: Record<string, unknown> = {
            firstName: "Grace",
            lastName: "Hopper",
            title: "Book",
            status: "archived",
        };
        applyMaterializers([materializeAuthor, materializePost], o3);
        assert.equal(o3.fullName, "Grace Hopper");
        assert.equal(o3.summary, "Book (archived)");
    });
});

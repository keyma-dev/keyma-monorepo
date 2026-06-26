/**
 * Formatter coverage — exercises the generated, phase-keyed formatters both
 * directly via `format(schema, value, phase)` and through the server's "save"
 * phase on create. `format` mutates its argument in place, so every direct
 * assertion builds a fresh plain object.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keyma, format } from "@keyma/runtime/schema";
import {
    makeHarness,
    validAuthor,
    validPost,
    Author,
    Post,
    Comment,
    Showcase,
} from "./setup.ts";

describe("formatting — direct format() per phase", () => {
    it("Author email: change trims", async () => {
        const v: Record<string, unknown> = { email: "  A@X.COM  " };
        await format(Author.schema, v, "change");
        assert.equal(v.email, "A@X.COM");
    });

    it("Author email: blur normalizeEmail (trim + lowercase)", async () => {
        const v: Record<string, unknown> = { email: "  A@X.COM  " };
        await format(Author.schema, v, "blur");
        assert.equal(v.email, "a@x.com");
    });

    it("Author email: save lowercases", async () => {
        const v: Record<string, unknown> = { email: "Alice@Example.COM" };
        await format(Author.schema, v, "save");
        assert.equal(v.email, "alice@example.com");
    });

    it("Author firstName: submit capitalizes", async () => {
        const v: Record<string, unknown> = { firstName: "alice" };
        await format(Author.schema, v, "submit");
        assert.equal(v.firstName, "Alice");
    });

    it("Post slug: save slugifies", async () => {
        const v: Record<string, unknown> = { slug: "Hello World!" };
        await format(Post.schema, v, "save");
        assert.equal(v.slug, "hello-world");
    });

    it("Post body: save trims", async () => {
        const v: Record<string, unknown> = { body: "   padded body   " };
        await format(Post.schema, v, "save");
        assert.equal(v.body, "padded body");
    });

    it("Post title: submit title-cases", async () => {
        const v: Record<string, unknown> = { title: "my cool title" };
        await format(Post.schema, v, "submit");
        assert.equal(v.title, "My Cool Title");
    });

    it("Post excerpt: submit truncate(200) cuts long strings to length 200", async () => {
        const long = "x".repeat(250);
        const v: Record<string, unknown> = { excerpt: long };
        await format(Post.schema, v, "submit");
        assert.equal((v.excerpt as string).length, 200);
        assert.equal(v.excerpt, "x".repeat(200));
    });

    it("Post excerpt: submit truncate(200) leaves short strings untouched", async () => {
        const v: Record<string, unknown> = { excerpt: "short" };
        await format(Post.schema, v, "submit");
        assert.equal(v.excerpt, "short");
    });

    it("Comment countryCode: change uppercases", async () => {
        const v: Record<string, unknown> = { countryCode: "us" };
        await format(Comment.schema, v, "change");
        assert.equal(v.countryCode, "US");
    });

    it("Showcase nationalId: change stripNonDigits", async () => {
        const v: Record<string, unknown> = { nationalId: "a1b2c3" };
        await format(Showcase.schema, v, "change");
        assert.equal(v.nationalId, "123");
    });

    it("Showcase apiPath: change ensureLeadingSlash (adds slash)", async () => {
        const v: Record<string, unknown> = { apiPath: "x" };
        await format(Showcase.schema, v, "change");
        assert.equal(v.apiPath, "/x");
    });

    it("Showcase apiPath: change ensureLeadingSlash (already slashed → unchanged)", async () => {
        const v: Record<string, unknown> = { apiPath: "/y" };
        await format(Showcase.schema, v, "change");
        assert.equal(v.apiPath, "/y");
    });
});

describe("formatting — phase isolation & skip-undefined", () => {
    it("email has no submit formatter → submit leaves email unchanged", async () => {
        const v: Record<string, unknown> = { email: "  A@X.COM  " };
        await format(Author.schema, v, "submit");
        assert.equal(v.email, "  A@X.COM  ");
    });

    it("save with only firstName present does not throw (email save formatter skipped)", async () => {
        const v: Record<string, unknown> = { firstName: "alice" };
        await assert.doesNotReject(format(Author.schema, v, "save"));
        // firstName has no save formatter, so it is unchanged at save.
        assert.equal(v.firstName, "alice");
    });
});

describe("formatting — server save phase on create", () => {
    it("Post create slugifies slug at save into the stored record", async () => {
        const { transport, adapter } = makeHarness();

        const created = await Keyma.mutation({
            p: Keyma.create(Post, validPost({ slug: "My Cool Slug" })),
        }).request({}, { inputs: {}, transport });

        assert.equal(created.results.p.ok, true, JSON.stringify(created.results.p));
        const id = created.results.p.ok ? (created.results.p.data as Post).id : "";
        assert.ok(id, "created post has an adapter-assigned id");

        const stored = adapter.stores.get("post")!.get(id)!;
        assert.equal(stored.slug, "my-cool-slug", "slugify ran at save phase");
    });

    it("Author create lowercases email at save into the stored record", async () => {
        const { transport, adapter } = makeHarness();

        const created = await Keyma.mutation({
            a: Keyma.create(Author, validAuthor({ email: "Alice@Example.COM" })),
        }).request({}, { inputs: {}, transport });

        assert.equal(created.results.a.ok, true, JSON.stringify(created.results.a));
        const id = created.results.a.ok ? (created.results.a.data as Author).id : "";
        assert.ok(id, "created author has an adapter-assigned id");

        const stored = adapter.stores.get("author")!.get(id)!;
        assert.equal(stored.email, "alice@example.com", "lowercase ran at save phase");
    });
});

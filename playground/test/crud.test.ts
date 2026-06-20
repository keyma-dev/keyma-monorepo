/**
 * End-to-end CRUD through the generated query/mutation builder, a KeymaServer and
 * the in-memory adapter — the path a real client would take.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keyma } from "@keyma/runtime-js";
import { makeHarness, seed, validAuthor, Author, Post } from "./setup.ts";

describe("crud — query builder + server + in-memory adapter", () => {
    it("create → read → list → count round-trips", async () => {
        const { transport } = makeHarness();

        const created = await Keyma.mutation({
            a: Keyma.create(Author, validAuthor()),
        }).request({}, { inputs: {}, transport });

        assert.equal(created.results.a.ok, true, JSON.stringify(created.results.a));
        const id = created.results.a.ok ? (created.results.a.data as Author).id : "";
        assert.ok(id, "created author has an adapter-assigned id");

        const read = await Keyma.query({
            one: Keyma.read(Author, { id: Keyma.input("id") }),
            all: Keyma.list(Author),
            n: Keyma.count(Author),
        }).request({}, { inputs: { one: { id } }, transport });

        assert.equal(read.results.one.ok, true);
        if (read.results.one.ok && read.results.one.data !== null) {
            assert.ok(read.results.one.data instanceof Author, "read hydrates into Author");
            assert.equal(read.results.one.data.email, "alice@example.com");
        }
        assert.equal(read.results.all.ok && read.results.all.data.length, 1);
        assert.equal(read.results.n.ok && read.results.n.data, 1);
    });

    it("update mutates and delete removes", async () => {
        const { transport, adapter } = makeHarness();
        seed(adapter, "author", { a1: { id: "a1", ...validAuthor() } });

        const upd = await Keyma.mutation({
            changed: Keyma.update(Author, { id: Keyma.input("id") }, { lastName: Keyma.input("lastName") }),
        }).request({}, { inputs: { changed: { id: "a1", lastName: "Stone" } }, transport });
        assert.equal(upd.results.changed.ok, true, JSON.stringify(upd.results.changed));
        if (upd.results.changed.ok) {
            assert.equal((upd.results.changed.data as Author).lastName, "Stone");
        }

        const del = await Keyma.mutation({
            gone: Keyma.delete(Author, { id: Keyma.input("id") }),
        }).request({}, { inputs: { gone: { id: "a1" } }, transport });
        assert.equal(del.results.gone.ok, true);

        const count = await Keyma.query({ n: Keyma.count(Author) }).request({}, { inputs: {}, transport });
        assert.equal(count.results.n.ok && count.results.n.data, 0);
    });

    it("where operators and skip/limit filter list results", async () => {
        const { transport, adapter } = makeHarness();
        seed(adapter, "post", {
            p1: { id: "p1", title: "A", slug: "a", body: "x", author: "a1", views: 10, status: "published" },
            p2: { id: "p2", title: "B", slug: "b", body: "y", author: "a1", views: 50, status: "published" },
            p3: { id: "p3", title: "C", slug: "c", body: "z", author: "a2", views: 99, status: "draft" },
        });

        const resp = await Keyma.query({
            popular: Keyma.list(Post, { views: { $gte: 50 } }),
            byAuthor: Keyma.list(Post, { author: "a1" }),
            published: Keyma.list(Post, { status: { $in: ["published"] } }),
        }).request(
            { popular: { limit: 1 }, byAuthor: {}, published: {} },
            { inputs: {}, transport },
        );

        assert.equal(resp.results.popular.ok && resp.results.popular.data.length, 1);
        assert.equal(resp.results.byAuthor.ok && resp.results.byAuthor.data.length, 2);
        assert.equal(resp.results.published.ok && resp.results.published.data.length, 2);
    });

    it("rejects an invalid create while a valid sibling leaf succeeds (per-leaf results)", async () => {
        const { transport } = makeHarness();
        const resp = await Keyma.mutation({
            good: Keyma.create(Author, validAuthor()),
            bad: Keyma.create(Author, validAuthor({ email: "not-an-email" })),
        }).request({}, { inputs: {}, transport });

        assert.equal(resp.results.good.ok, true, JSON.stringify(resp.results.good));
        assert.equal(resp.results.bad.ok, false);
        if (!resp.results.bad.ok) {
            assert.equal(resp.results.bad.code, "VALIDATION_FAILED");
        }
    });

    it("create applies defaults (literal + expression) to the stored record", async () => {
        const { transport, adapter } = makeHarness();
        await Keyma.mutation({ a: Keyma.create(Author, validAuthor()) }).request({}, { inputs: {}, transport });

        const stored = [...adapter.stores.get("author")!.values()][0]!;
        assert.equal(stored.theme, "system", "literal string default applied");
        assert.equal(stored.role, "viewer", "enum literal default applied");
        assert.ok(stored.createdAt instanceof Date, "expression default Now() applied");
    });
});

/**
 * Graph-edge end-to-end tests through the generated server bundle.
 *
 * Edges (FOLLOWS / RELATED) are created and read via the low-level
 * `server.handle({ operations })` API — the same shape integration.test.ts
 * exercises for `knows`. The InMemoryAdapter does NOT implement `traverse`,
 * so `Keyma.traverse` is intentionally not covered here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, seed, Follows, Related } from "./setup.ts";

describe("edges — create with node objects, read populates endpoints", () => {
    it("create FOLLOWS extracts endpoint ids and round-trips since", async () => {
        const { server, adapter } = makeHarness();
        // create resolves edge endpoints against the node store; seed the
        // endpoint authors so they resolve to `{ id }` rather than null.
        seed(adapter, "author", {
            a1: { id: "a1", firstName: "Alice", lastName: "Ng", email: "alice@example.com" },
            a2: { id: "a2", firstName: "Bob", lastName: "Lee", email: "bob@example.com" },
        });
        const resp = await server.handle({
            operations: {
                c: {
                    op: "create",
                    schema: "FOLLOWS",
                    data: {
                        id: "f1",
                        since: "2024-01-01",
                        follower: { id: "a1" },
                        following: { id: "a2" },
                    },
                },
            },
        });

        const r = resp.results["c"]!;
        assert.equal(r.ok, true, JSON.stringify(r));
        if (r.ok) {
            const data = r.data as Record<string, unknown>;
            assert.deepEqual(data["follower"], { id: "a1" });
            assert.deepEqual(data["following"], { id: "a2" });
            assert.equal(data["since"], "2024-01-01");
            assert.equal(data["id"], "f1");
        }
    });

    it("read FOLLOWS returns endpoints as { id } by default", async () => {
        const { server, adapter } = makeHarness();
        // The runtime resolves edge endpoints against the node store on read;
        // a missing node resolves to null, so seed the endpoint authors to get
        // the documented `{ id }` default back.
        seed(adapter, "author", {
            a1: { id: "a1", firstName: "Alice", lastName: "Ng", email: "alice@example.com" },
            a2: { id: "a2", firstName: "Bob", lastName: "Lee", email: "bob@example.com" },
        });
        await server.handle({
            operations: {
                c: {
                    op: "create",
                    schema: "FOLLOWS",
                    data: { id: "f1", since: "2024-01-01", follower: { id: "a1" }, following: { id: "a2" } },
                },
            },
        });

        const resp = await server.handle({
            operations: { r: { op: "read", schema: "FOLLOWS", where: { id: "f1" } } },
        });

        const r = resp.results["r"]!;
        assert.equal(r.ok, true, JSON.stringify(r));
        if (r.ok) {
            const data = r.data as Record<string, unknown>;
            assert.deepEqual(data["follower"], { id: "a1" });
            assert.deepEqual(data["following"], { id: "a2" });
            assert.equal(data["since"], "2024-01-01");
        }
    });

    it("read FOLLOWS populates an endpoint from the projection (id always kept)", async () => {
        const { server, adapter } = makeHarness();
        seed(adapter, "author", {
            a1: { id: "a1", firstName: "Alice", lastName: "Ng", email: "alice@example.com" },
            a2: { id: "a2", firstName: "Bob", lastName: "Lee", email: "bob@example.com" },
        });
        await server.handle({
            operations: {
                c: {
                    op: "create",
                    schema: "FOLLOWS",
                    data: { id: "f1", since: "2024-01-01", follower: { id: "a1" }, following: { id: "a2" } },
                },
            },
        });

        const resp = await server.handle({
            operations: {
                r: {
                    op: "read",
                    schema: "FOLLOWS",
                    where: { id: "f1" },
                    project: { since: 1, follower: { firstName: 1 }, following: 1 },
                },
            },
        });

        const r = resp.results["r"]!;
        assert.equal(r.ok, true, JSON.stringify(r));
        if (r.ok) {
            const data = r.data as Record<string, unknown>;
            // follower is populated: firstName pulled from author a1, id always retained.
            assert.deepEqual(data["follower"], { firstName: "Alice", id: "a1" });
            // following requested with `1` (not a sub-projection) -> stays { id }.
            assert.deepEqual(data["following"], { id: "a2" });
            assert.equal(data["since"], "2024-01-01");
        }
    });

    it("create + read RELATED (undirected) between a post and a tag round-trips", async () => {
        const { server, adapter } = makeHarness();
        seed(adapter, "post", { p1: { id: "p1", title: "Post One", slug: "post-one", body: "body" } });
        seed(adapter, "tag", { t1: { id: "t1", label: "News", slug: "news" } });

        const created = await server.handle({
            operations: {
                c: {
                    op: "create",
                    schema: "RELATED",
                    data: { id: "r1", post: { id: "p1" }, tag: { id: "t1" } },
                },
            },
        });
        const c = created.results["c"]!;
        assert.equal(c.ok, true, JSON.stringify(c));
        if (c.ok) {
            const data = c.data as Record<string, unknown>;
            assert.deepEqual(data["post"], { id: "p1" });
            assert.deepEqual(data["tag"], { id: "t1" });
            assert.equal(data["id"], "r1");
        }

        const read = await server.handle({
            operations: { r: { op: "read", schema: "RELATED", where: { id: "r1" } } },
        });
        const r = read.results["r"]!;
        assert.equal(r.ok, true, JSON.stringify(r));
        if (r.ok) {
            const data = r.data as Record<string, unknown>;
            assert.deepEqual(data["post"], { id: "p1" });
            assert.deepEqual(data["tag"], { id: "t1" });
        }
    });

    it("edge metadata is emitted exactly", () => {
        assert.deepEqual(Follows.schema.edge, {
            from: "Author",
            fromField: "follower",
            to: "Author",
            toField: "following",
            label: "FOLLOWS",
            directed: true,
        });
        assert.equal(Related.schema.edge?.directed, false);
        assert.deepEqual(Related.schema.edge, {
            from: "Post",
            fromField: "post",
            to: "Tag",
            toField: "tag",
            label: "RELATED",
            directed: false,
        });
    });
});

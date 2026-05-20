import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AdapterTraversalContext, SchemaMetadata } from "@keyma/runtime-js";
import { MongoAdapter } from "../src/index.js";
import {
    AUTHORSHIP_SCHEMA,
    FRIENDSHIP_SCHEMA,
    OIDS,
    ORG_SCHEMA,
    POST_SCHEMA,
    TAG_SCHEMA,
    TAGGING_SCHEMA,
    USER_SCHEMA,
} from "./fixtures.js";
import { clean, startMongo, stopMongo, type TestHandle } from "./setup.js";

function makeCtx(
    start: SchemaMetadata,
    terminal: SchemaMetadata,
    edges: SchemaMetadata[],
    nodes: SchemaMetadata[],
): AdapterTraversalContext {
    return {
        startSchema: start,
        terminalSchema: terminal,
        edges: new Map(edges.map((e) => [e.name, e])),
        nodes: new Map(nodes.map((n) => [n.name, n])),
    };
}

describe("MongoAdapter — traverse", () => {
    let h: TestHandle;
    let adapter: MongoAdapter;

    before(async () => {
        h = await startMongo();
    });
    after(async () => {
        await stopMongo(h);
    });

    beforeEach(async () => {
        await clean(h);
        adapter = new MongoAdapter(h.db);
        for (const s of [
            ORG_SCHEMA,
            USER_SCHEMA,
            POST_SCHEMA,
            TAG_SCHEMA,
            FRIENDSHIP_SCHEMA,
            AUTHORSHIP_SCHEMA,
            TAGGING_SCHEMA,
        ]) {
            await adapter.ensureSchema(s);
        }
    });

    async function seedAuthorshipGraph(): Promise<void> {
        await adapter.create(USER_SCHEMA, { id: OIDS.alice, email: "alice@x.com", name: "alice" });
        await adapter.create(USER_SCHEMA, { id: OIDS.bob,   email: "bob@x.com",   name: "bob" });
        await adapter.create(POST_SCHEMA, { id: OIDS.p1, title: "p1" });
        await adapter.create(POST_SCHEMA, { id: OIDS.p2, title: "p2" });
        await adapter.create(POST_SCHEMA, { id: OIDS.p3, title: "p3" });
        await adapter.create(TAG_SCHEMA,  { id: OIDS.tech, label: "tech" });
        await adapter.create(TAG_SCHEMA,  { id: OIDS.news, label: "news" });
        // alice→p1, alice→p2, bob→p3
        await adapter.create(AUTHORSHIP_SCHEMA, { id: OIDS.a1, author: OIDS.alice, post: OIDS.p1 });
        await adapter.create(AUTHORSHIP_SCHEMA, { id: OIDS.a2, author: OIDS.alice, post: OIDS.p2 });
        await adapter.create(AUTHORSHIP_SCHEMA, { id: OIDS.a3, author: OIDS.bob,   post: OIDS.p3 });
        // p1→tech, p2→news, p3→tech
        await adapter.create(TAGGING_SCHEMA, { id: OIDS.t1, post: OIDS.p1, tag: OIDS.tech });
        await adapter.create(TAGGING_SCHEMA, { id: OIDS.t2, post: OIDS.p2, tag: OIDS.news });
        await adapter.create(TAGGING_SCHEMA, { id: OIDS.t3, post: OIDS.p3, tag: OIDS.tech });
    }

    it("heterogeneous chain User → wrote → Post → tagged → Tag returns tags", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            TAG_SCHEMA,
            [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA],
        );
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.alice } },
            steps: [
                { via: "authorship", direction: "out" },
                { via: "tagging", direction: "out" },
            ],
            emit: "nodes",
        });
        const tagIds = (result as Record<string, unknown>[])
            .map((r) => r["id"])
            .sort();
        assert.deepEqual(tagIds, [OIDS.tech, OIDS.news].sort());
    });

    it("emit: edges returns the last-hop edge", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            TAG_SCHEMA,
            [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA],
        );
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.alice } },
            steps: [
                { via: "authorship", direction: "out" },
                { via: "tagging", direction: "out" },
            ],
            emit: "edges",
        });
        const rows = result as Record<string, unknown>[];
        assert.equal(rows.length, 2);
        const ids = rows.map((r) => r["id"]).sort();
        assert.deepEqual(ids, [OIDS.t1, OIDS.t2].sort());
    });

    it("emit: paths returns { nodes, edges } per path", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            TAG_SCHEMA,
            [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA],
        );
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.alice } },
            steps: [
                { via: "authorship", direction: "out" },
                { via: "tagging", direction: "out" },
            ],
            emit: "paths",
        });
        const paths = result as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }[];
        assert.equal(paths.length, 2);
        for (const p of paths) {
            assert.equal(p.nodes.length, 3);
            assert.equal(p.edges.length, 2);
        }
    });

    it("direction: in traverses backwards (Tag → tagged-by → Post → wrote-by → User)", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(
            TAG_SCHEMA,
            USER_SCHEMA,
            [TAGGING_SCHEMA, AUTHORSHIP_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA],
        );
        const result = await adapter.traverse(ctx, {
            start: { schema: "tag", where: { id: OIDS.tech } },
            steps: [
                { via: "tagging", direction: "in" },
                { via: "authorship", direction: "in" },
            ],
            emit: "nodes",
        });
        const userIds = (result as Record<string, unknown>[])
            .map((r) => r["id"])
            .sort();
        assert.deepEqual(userIds, [OIDS.alice, OIDS.bob].sort());
    });

    it("step.edgeWhere filters edges", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            POST_SCHEMA,
            [AUTHORSHIP_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA],
        );
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.alice } },
            steps: [
                { via: "authorship", direction: "out", edgeWhere: { post: OIDS.p1 } },
            ],
            emit: "nodes",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]);
        assert.deepEqual(ids, [OIDS.p1]);
    });

    it("step.nodeWhere filters intermediate connected nodes", async () => {
        await seedAuthorshipGraph();
        // alice → p1 → tech ; alice → p2 → news
        // Constrain the intermediate Post to title "p1" — only the tech tag
        // should remain.
        const ctx = makeCtx(
            USER_SCHEMA,
            TAG_SCHEMA,
            [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA],
        );
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.alice } },
            steps: [
                { via: "authorship", direction: "out", nodeWhere: { title: "p1" } },
                { via: "tagging", direction: "out" },
            ],
            emit: "nodes",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]);
        assert.deepEqual(ids, [OIDS.tech]);
    });

    it("step.nodeWhere prunes the chain early when no intermediate matches", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            TAG_SCHEMA,
            [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA],
        );
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.alice } },
            steps: [
                { via: "authorship", direction: "out", nodeWhere: { title: "no-such-post" } },
                { via: "tagging", direction: "out" },
            ],
            emit: "nodes",
        });
        assert.deepEqual(result, []);
    });

    it("step.nodeWhere on the terminal step filters terminal nodes", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            TAG_SCHEMA,
            [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA],
        );
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.alice } },
            steps: [
                { via: "authorship", direction: "out" },
                { via: "tagging", direction: "out", nodeWhere: { label: "news" } },
            ],
            emit: "nodes",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]);
        assert.deepEqual(ids, [OIDS.news]);
    });

    it("step.nodeWhere combines with step.edgeWhere on the same step", async () => {
        await seedAuthorshipGraph();
        // edgeWhere narrows the authorship edge to p1 only, nodeWhere then
        // requires the post title to match "p1" — both must hold.
        const ctx = makeCtx(
            USER_SCHEMA,
            POST_SCHEMA,
            [AUTHORSHIP_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA],
        );
        const matching = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.alice } },
            steps: [
                {
                    via: "authorship",
                    direction: "out",
                    edgeWhere: { post: OIDS.p1 },
                    nodeWhere: { title: "p1" },
                },
            ],
            emit: "nodes",
        });
        assert.deepEqual(
            (matching as Record<string, unknown>[]).map((r) => r["id"]),
            [OIDS.p1],
        );
        // Conflicting edgeWhere/nodeWhere should yield no results.
        const conflicting = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.alice } },
            steps: [
                {
                    via: "authorship",
                    direction: "out",
                    edgeWhere: { post: OIDS.p1 },
                    nodeWhere: { title: "p2" },
                },
            ],
            emit: "nodes",
        });
        assert.deepEqual(conflicting, []);
    });

    async function seedFriendGraph(): Promise<void> {
        for (const id of [OIDS.a, OIDS.b, OIDS.c, OIDS.d, OIDS.e]) {
            await adapter.create(USER_SCHEMA, { id, email: `${id}@x.com`, name: id });
        }
        // a-b-c-d-e chain
        await adapter.create(FRIENDSHIP_SCHEMA, { id: OIDS.f1, userA: OIDS.a, userB: OIDS.b });
        await adapter.create(FRIENDSHIP_SCHEMA, { id: OIDS.f2, userA: OIDS.b, userB: OIDS.c });
        await adapter.create(FRIENDSHIP_SCHEMA, { id: OIDS.f3, userA: OIDS.c, userB: OIDS.d });
        await adapter.create(FRIENDSHIP_SCHEMA, { id: OIDS.f4, userA: OIDS.d, userB: OIDS.e });
    }

    it("homogeneous repeat: depth.max returns users up to N hops", async () => {
        await seedFriendGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            USER_SCHEMA,
            [FRIENDSHIP_SCHEMA],
            [USER_SCHEMA],
        );
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { max: 3 },
            emit: "nodes",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]).sort();
        assert.deepEqual(ids, [OIDS.b, OIDS.c, OIDS.d].sort());
    });

    it("repeat with depth.min skips direct connections", async () => {
        await seedFriendGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            USER_SCHEMA,
            [FRIENDSHIP_SCHEMA],
            [USER_SCHEMA],
        );
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { min: 2, max: 4 },
            emit: "nodes",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]).sort();
        assert.deepEqual(ids, [OIDS.c, OIDS.d, OIDS.e].sort());
    });

    it("repeat with emit: edges returns traversed edges", async () => {
        await seedFriendGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            USER_SCHEMA,
            [FRIENDSHIP_SCHEMA],
            [USER_SCHEMA],
        );
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { max: 2 },
            emit: "edges",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]).sort();
        assert.deepEqual(ids, [OIDS.f1, OIDS.f2].sort());
    });

    it("repeat with emit: paths returns ordered paths via unrolled fallback", async () => {
        await seedFriendGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            USER_SCHEMA,
            [FRIENDSHIP_SCHEMA],
            [USER_SCHEMA],
        );
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { min: 1, max: 3 },
            emit: "paths",
        });
        const paths = result as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }[];
        assert.equal(paths.length, 3);
        const sorted = paths.map((p) => p.nodes.map((n) => n["id"]).join("-")).sort();
        const expected = [
            [OIDS.a, OIDS.b].join("-"),
            [OIDS.a, OIDS.b, OIDS.c].join("-"),
            [OIDS.a, OIDS.b, OIDS.c, OIDS.d].join("-"),
        ].sort();
        assert.deepEqual(sorted, expected);
    });

    // ─── Pagination (skip / limit / sort) ───────────────────────────────────

    it("steps mode + emit: nodes — sort + limit returns a deterministic slice", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            POST_SCHEMA,
            [AUTHORSHIP_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA],
        );
        // alice wrote p1 ("p1") and p2 ("p2"). Sort by title desc, limit 1 → p2.
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.alice } },
            steps: [{ via: "authorship", direction: "out" }],
            emit: "nodes",
            options: { sort: { title: -1 }, limit: 1 },
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]);
        assert.deepEqual(ids, [OIDS.p2]);
    });

    it("steps mode + emit: nodes — skip+limit is stable across calls (default _id sort)", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            POST_SCHEMA,
            [AUTHORSHIP_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA],
        );
        const spec = {
            start: { schema: "user", where: { id: OIDS.alice } },
            steps: [{ via: "authorship", direction: "out" as const }],
            emit: "nodes" as const,
            options: { skip: 1, limit: 1 },
        };
        const r1 = (await adapter.traverse(ctx, spec)) as Record<string, unknown>[];
        const r2 = (await adapter.traverse(ctx, spec)) as Record<string, unknown>[];
        assert.equal(r1.length, 1);
        assert.deepEqual(
            r1.map((r) => r["id"]),
            r2.map((r) => r["id"]),
        );
    });

    it("repeat mode + emit: nodes — sort + limit slices reachable set", async () => {
        await seedFriendGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            USER_SCHEMA,
            [FRIENDSHIP_SCHEMA],
            [USER_SCHEMA],
        );
        // From a, reachable up to depth 3: b, c, d. `seedFriendGraph` stores
        // each user's id as the `name` field, so sorting by name desc orders
        // them by their hex OID — d (oid 17), c (oid 16), b (oid 15). Limit 2.
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { max: 3 },
            emit: "nodes",
            options: { sort: { name: -1 }, limit: 2 },
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]);
        assert.deepEqual(ids, [OIDS.d, OIDS.c]);
    });

    it("repeat mode + emit: nodes — _id tiebreaker yields stable order across ties", async () => {
        // Star graph from a → b/c/d/e, where b and c share name "twin" but
        // differ by _id. With sort { name: 1 }, "twin" entries should come
        // before "z*" entries; within the twin pair, _id ascending decides.
        await adapter.create(USER_SCHEMA, { id: OIDS.a, email: "a@x.com", name: "a" });
        await adapter.create(USER_SCHEMA, { id: OIDS.b, email: "b@x.com", name: "twin" });
        await adapter.create(USER_SCHEMA, { id: OIDS.c, email: "c@x.com", name: "twin" });
        await adapter.create(USER_SCHEMA, { id: OIDS.d, email: "d@x.com", name: "zoe" });
        await adapter.create(FRIENDSHIP_SCHEMA, { id: OIDS.f1, userA: OIDS.a, userB: OIDS.b });
        await adapter.create(FRIENDSHIP_SCHEMA, { id: OIDS.f2, userA: OIDS.a, userB: OIDS.c });
        await adapter.create(FRIENDSHIP_SCHEMA, { id: OIDS.f3, userA: OIDS.a, userB: OIDS.d });

        const ctx = makeCtx(
            USER_SCHEMA,
            USER_SCHEMA,
            [FRIENDSHIP_SCHEMA],
            [USER_SCHEMA],
        );
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { max: 1 },
            emit: "nodes",
            options: { sort: { name: 1 } },
        });
        const rows = result as Record<string, unknown>[];
        // _id ascending for OIDS.b vs OIDS.c — b is mkoid(21), c is mkoid(22).
        assert.deepEqual(
            rows.map((r) => r["id"]),
            [OIDS.b, OIDS.c, OIDS.d],
        );
    });

    it("repeat mode + emit: paths — sort by terminal field works across depths", async () => {
        await seedFriendGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            USER_SCHEMA,
            [FRIENDSHIP_SCHEMA],
            [USER_SCHEMA],
        );
        // Depths 1..3 from a yield paths whose terminal nodes are b, c, d.
        // `name` equals the OID hex; sorted desc and limit 2 → d (oid 17),
        // c (oid 16).
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { min: 1, max: 3 },
            emit: "paths",
            options: { sort: { name: -1 }, limit: 2 },
        });
        const paths = result as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }[];
        assert.equal(paths.length, 2);
        const terminals = paths.map((p) => p.nodes[p.nodes.length - 1]!["id"]);
        assert.deepEqual(terminals, [OIDS.d, OIDS.c]);
        // Paths returned should not have an artifact _terminal field.
        for (const p of paths) {
            for (const n of p.nodes) {
                assert.equal(("_terminal" in n), false);
            }
        }
    });

    it("steps mode + emit: paths — sort by terminal index slot + tiebreaker", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            TAG_SCHEMA,
            [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA],
        );
        // alice → p1 → tech, alice → p2 → news. Sort by terminal tag label asc,
        // limit 1 → news. Asc because "news" < "tech".
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.alice } },
            steps: [
                { via: "authorship", direction: "out" },
                { via: "tagging", direction: "out" },
            ],
            emit: "paths",
            options: { sort: { label: 1 }, limit: 1 },
        });
        const paths = result as { nodes: Record<string, unknown>[] }[];
        assert.equal(paths.length, 1);
        const terminal = paths[0]!.nodes[paths[0]!.nodes.length - 1]!;
        assert.equal(terminal["label"], "news");
    });

    it("terminal spec.where filters terminal nodes", async () => {
        await seedFriendGraph();
        const ctx = makeCtx(
            USER_SCHEMA,
            USER_SCHEMA,
            [FRIENDSHIP_SCHEMA],
            [USER_SCHEMA],
        );
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: OIDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { max: 3 },
            where: { id: { $in: [OIDS.c, OIDS.d] } },
            emit: "nodes",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]).sort();
        assert.deepEqual(ids, [OIDS.c, OIDS.d].sort());
    });
});

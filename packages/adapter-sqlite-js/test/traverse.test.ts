import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AdapterTraversalContext, SchemaMetadata } from "@keyma/runtime/schema";
import { SqliteAdapter } from "../src/index.js";
import {
    ALL_SCHEMAS, AUTHORSHIP_SCHEMA, FRIENDSHIP_SCHEMA, IDS,
    POST_SCHEMA, TAG_SCHEMA, TAGGING_SCHEMA, USER_SCHEMA,
} from "./fixtures.js";
import { clean, startSqlite, stopSqlite, type TestHandle } from "./setup.js";

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

describe("SqliteAdapter — traverse step mode", () => {
    let h: TestHandle;
    let adapter: SqliteAdapter;

    before(() => { h = startSqlite(); });
    after(async () => { await stopSqlite(h); });

    async function seedAuthorshipGraph(): Promise<void> {
        await adapter.create(USER_SCHEMA, { id: IDS.alice, email: "alice@x.com", name: "alice" });
        await adapter.create(USER_SCHEMA, { id: IDS.bob, email: "bob@x.com", name: "bob" });
        await adapter.create(POST_SCHEMA, { id: IDS.p1, title: "p1" });
        await adapter.create(POST_SCHEMA, { id: IDS.p2, title: "p2" });
        await adapter.create(POST_SCHEMA, { id: IDS.p3, title: "p3" });
        await adapter.create(TAG_SCHEMA, { id: IDS.tech, label: "tech" });
        await adapter.create(TAG_SCHEMA, { id: IDS.news, label: "news" });
        await adapter.create(AUTHORSHIP_SCHEMA, { id: IDS.a1, author: IDS.alice, post: IDS.p1 });
        await adapter.create(AUTHORSHIP_SCHEMA, { id: IDS.a2, author: IDS.alice, post: IDS.p2 });
        await adapter.create(AUTHORSHIP_SCHEMA, { id: IDS.a3, author: IDS.bob, post: IDS.p3 });
        await adapter.create(TAGGING_SCHEMA, { id: IDS.t1, post: IDS.p1, tag: IDS.tech });
        await adapter.create(TAGGING_SCHEMA, { id: IDS.t2, post: IDS.p2, tag: IDS.news });
        await adapter.create(TAGGING_SCHEMA, { id: IDS.t3, post: IDS.p3, tag: IDS.tech });
    }

    beforeEach(async () => {
        await clean(h);
        adapter = new SqliteAdapter(h.db);
        for (const s of ALL_SCHEMAS) await adapter.ensureSchema(s);
    });

    it("heterogeneous chain User → wrote → Post → tagged → Tag returns tags", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, TAG_SCHEMA,
            [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA]);
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
            steps: [
                { via: "authorship", direction: "out" },
                { via: "tagging", direction: "out" },
            ],
            emit: "nodes",
        });
        const tagIds = (result as Record<string, unknown>[]).map((r) => r["id"]).sort();
        assert.deepEqual(tagIds, [IDS.tech, IDS.news].sort());
    });

    it("emit: edges returns the last-hop edge", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, TAG_SCHEMA,
            [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA]);
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
            steps: [
                { via: "authorship", direction: "out" },
                { via: "tagging", direction: "out" },
            ],
            emit: "edges",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]).sort();
        assert.deepEqual(ids, [IDS.t1, IDS.t2].sort());
    });

    it("emit: paths returns { nodes, edges } per path", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, TAG_SCHEMA,
            [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA]);
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
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
            assert.equal(p.nodes[0]?.["id"], IDS.alice);
        }
    });

    it("direction: in traverses backwards (Tag → tagged-by → Post → wrote-by → User)", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(TAG_SCHEMA, USER_SCHEMA,
            [TAGGING_SCHEMA, AUTHORSHIP_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA]);
        const result = await adapter.traverse(ctx, {
            start: { schema: "tag", where: { id: IDS.tech } },
            steps: [
                { via: "tagging", direction: "in" },
                { via: "authorship", direction: "in" },
            ],
            emit: "nodes",
        });
        const userIds = (result as Record<string, unknown>[]).map((r) => r["id"]).sort();
        assert.deepEqual(userIds, [IDS.alice, IDS.bob].sort());
    });

    it("step.edgeWhere filters edges", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, POST_SCHEMA,
            [AUTHORSHIP_SCHEMA], [USER_SCHEMA, POST_SCHEMA]);
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
            steps: [
                { via: "authorship", direction: "out", edgeWhere: { post: IDS.p1 } },
            ],
            emit: "nodes",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]);
        assert.deepEqual(ids, [IDS.p1]);
    });

    it("step.nodeWhere filters intermediate connected nodes", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, TAG_SCHEMA,
            [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA]);
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
            steps: [
                { via: "authorship", direction: "out", nodeWhere: { title: "p1" } },
                { via: "tagging", direction: "out" },
            ],
            emit: "nodes",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]);
        assert.deepEqual(ids, [IDS.tech]);
    });

    it("terminal spec.where filters terminal nodes", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, TAG_SCHEMA,
            [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA],
            [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA]);
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
            steps: [
                { via: "authorship", direction: "out" },
                { via: "tagging", direction: "out" },
            ],
            where: { label: "tech" },
            emit: "nodes",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]);
        assert.deepEqual(ids, [IDS.tech]);
    });

    it("steps mode + sort/limit slices the terminal nodes", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, POST_SCHEMA,
            [AUTHORSHIP_SCHEMA], [USER_SCHEMA, POST_SCHEMA]);
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
            steps: [{ via: "authorship", direction: "out" }],
            emit: "nodes",
            options: { sort: { title: -1 }, limit: 1 },
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]);
        assert.deepEqual(ids, [IDS.p2]);
    });
});

describe("SqliteAdapter — traverse repeat mode", () => {
    let h: TestHandle;
    let adapter: SqliteAdapter;

    before(() => { h = startSqlite(); });
    after(async () => { await stopSqlite(h); });

    async function seedFriendChain(): Promise<void> {
        for (const id of [IDS.a, IDS.b, IDS.c, IDS.d, IDS.e]) {
            await adapter.create(USER_SCHEMA, { id, email: `${id}@x.com`, name: id });
        }
        // a-b-c-d-e
        await adapter.create(FRIENDSHIP_SCHEMA, { id: IDS.f1, userA: IDS.a, userB: IDS.b });
        await adapter.create(FRIENDSHIP_SCHEMA, { id: IDS.f2, userA: IDS.b, userB: IDS.c });
        await adapter.create(FRIENDSHIP_SCHEMA, { id: IDS.f3, userA: IDS.c, userB: IDS.d });
        await adapter.create(FRIENDSHIP_SCHEMA, { id: IDS.f4, userA: IDS.d, userB: IDS.e });
    }

    beforeEach(async () => {
        await clean(h);
        adapter = new SqliteAdapter(h.db);
        for (const s of ALL_SCHEMAS) await adapter.ensureSchema(s);
    });

    it("homogeneous repeat: depth.max returns users up to N hops", async () => {
        await seedFriendChain();
        const ctx = makeCtx(USER_SCHEMA, USER_SCHEMA, [FRIENDSHIP_SCHEMA], [USER_SCHEMA]);
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { max: 3 },
            emit: "nodes",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]).sort();
        assert.deepEqual(ids, [IDS.b, IDS.c, IDS.d].sort());
    });

    it("repeat with depth.min skips direct connections", async () => {
        await seedFriendChain();
        const ctx = makeCtx(USER_SCHEMA, USER_SCHEMA, [FRIENDSHIP_SCHEMA], [USER_SCHEMA]);
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { min: 2, max: 4 },
            emit: "nodes",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]).sort();
        assert.deepEqual(ids, [IDS.c, IDS.d, IDS.e].sort());
    });

    it("repeat with emit: edges returns traversed edges", async () => {
        await seedFriendChain();
        const ctx = makeCtx(USER_SCHEMA, USER_SCHEMA, [FRIENDSHIP_SCHEMA], [USER_SCHEMA]);
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { max: 2 },
            emit: "edges",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]).sort();
        assert.deepEqual(ids, [IDS.f1, IDS.f2].sort());
    });

    it("repeat with emit: paths returns ordered paths via unrolled fallback", async () => {
        await seedFriendChain();
        const ctx = makeCtx(USER_SCHEMA, USER_SCHEMA, [FRIENDSHIP_SCHEMA], [USER_SCHEMA]);
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { min: 1, max: 3 },
            emit: "paths",
        });
        const paths = result as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }[];
        assert.equal(paths.length, 3);
        const sorted = paths.map((p) => p.nodes.map((n) => n["id"]).join("-")).sort();
        const expected = [
            [IDS.a, IDS.b].join("-"),
            [IDS.a, IDS.b, IDS.c].join("-"),
            [IDS.a, IDS.b, IDS.c, IDS.d].join("-"),
        ].sort();
        assert.deepEqual(sorted, expected);
    });

    it("repeat applies edgeWhere to each hop", async () => {
        await seedFriendChain();
        const ctx = makeCtx(USER_SCHEMA, USER_SCHEMA, [FRIENDSHIP_SCHEMA], [USER_SCHEMA]);
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.a } },
            repeat: { via: "friendship", direction: "out", edgeWhere: { userB: IDS.b } },
            depth: { max: 3 },
            emit: "nodes",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]);
        assert.deepEqual(ids, [IDS.b]);
    });

    it("terminal spec.where filters terminal nodes", async () => {
        await seedFriendChain();
        const ctx = makeCtx(USER_SCHEMA, USER_SCHEMA, [FRIENDSHIP_SCHEMA], [USER_SCHEMA]);
        const result = await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { max: 3 },
            where: { id: { $in: [IDS.c, IDS.d] } },
            emit: "nodes",
        });
        const ids = (result as Record<string, unknown>[]).map((r) => r["id"]).sort();
        assert.deepEqual(ids, [IDS.c, IDS.d].sort());
    });
});

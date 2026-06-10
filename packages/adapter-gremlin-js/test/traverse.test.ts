import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AdapterTraversalContext, SchemaMetadata } from "@keyma/runtime-js";
import { GremlinAdapter } from "../src/index.js";
import {
    AUTHORSHIP_SCHEMA,
    FRIENDSHIP_SCHEMA,
    IDS,
    POST_SCHEMA,
    TAG_SCHEMA,
    TAGGING_SCHEMA,
    USER_SCHEMA,
} from "./fixtures.js";
import { clean, close, connect, factory, hasServer, type LiveHandle } from "./setup.js";

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

type Rec = Record<string, unknown>;
type Path = { nodes: Rec[]; edges: Rec[] };

describe("GremlinAdapter — traverse", { skip: !hasServer }, () => {
    let h: LiveHandle;
    let adapter: GremlinAdapter;

    before(async () => {
        h = await connect();
    });
    after(async () => {
        await close(h);
    });
    beforeEach(async () => {
        await clean(h);
        adapter = new GremlinAdapter(factory());
        for (const s of [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA, FRIENDSHIP_SCHEMA, AUTHORSHIP_SCHEMA, TAGGING_SCHEMA]) {
            await adapter.ensureSchema(s);
        }
    });
    afterEach(async () => {
        await adapter.close();
    });

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

    it("heterogeneous chain User → wrote → Post → tagged → Tag returns tags", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, TAG_SCHEMA, [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA], [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA]);
        const result = (await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
            steps: [{ via: "authorship", direction: "out" }, { via: "tagging", direction: "out" }],
            emit: "nodes",
        })) as Rec[];
        assert.deepEqual(result.map((r) => r["id"]).sort(), [IDS.tech, IDS.news].sort());
    });

    it("emit: edges returns the last-hop edge", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, TAG_SCHEMA, [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA], [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA]);
        const result = (await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
            steps: [{ via: "authorship", direction: "out" }, { via: "tagging", direction: "out" }],
            emit: "edges",
        })) as Rec[];
        assert.deepEqual(result.map((r) => r["id"]).sort(), [IDS.t1, IDS.t2].sort());
    });

    it("emit: paths returns { nodes, edges } per path", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, TAG_SCHEMA, [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA], [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA]);
        const result = (await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
            steps: [{ via: "authorship", direction: "out" }, { via: "tagging", direction: "out" }],
            emit: "paths",
        })) as Path[];
        assert.equal(result.length, 2);
        for (const p of result) {
            assert.equal(p.nodes.length, 3);
            assert.equal(p.edges.length, 2);
        }
    });

    it("direction: in traverses backwards (Tag → Post → User)", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(TAG_SCHEMA, USER_SCHEMA, [TAGGING_SCHEMA, AUTHORSHIP_SCHEMA], [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA]);
        const result = (await adapter.traverse(ctx, {
            start: { schema: "tag", where: { id: IDS.tech } },
            steps: [{ via: "tagging", direction: "in" }, { via: "authorship", direction: "in" }],
            emit: "nodes",
        })) as Rec[];
        assert.deepEqual(result.map((r) => r["id"]).sort(), [IDS.alice, IDS.bob].sort());
    });

    it("step.edgeWhere filters edges", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, POST_SCHEMA, [AUTHORSHIP_SCHEMA], [USER_SCHEMA, POST_SCHEMA]);
        const result = (await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
            steps: [{ via: "authorship", direction: "out", edgeWhere: { post: IDS.p1 } }],
            emit: "nodes",
        })) as Rec[];
        assert.deepEqual(result.map((r) => r["id"]), [IDS.p1]);
    });

    it("step.nodeWhere filters intermediate connected nodes", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, TAG_SCHEMA, [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA], [USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA]);
        const result = (await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
            steps: [{ via: "authorship", direction: "out", nodeWhere: { title: "p1" } }, { via: "tagging", direction: "out" }],
            emit: "nodes",
        })) as Rec[];
        assert.deepEqual(result.map((r) => r["id"]), [IDS.tech]);
    });

    async function seedFriendGraph(): Promise<void> {
        for (const id of [IDS.a, IDS.b, IDS.c, IDS.d, IDS.e]) {
            await adapter.create(USER_SCHEMA, { id, email: `${id}@x.com`, name: id });
        }
        await adapter.create(FRIENDSHIP_SCHEMA, { id: IDS.f1, userA: IDS.a, userB: IDS.b });
        await adapter.create(FRIENDSHIP_SCHEMA, { id: IDS.f2, userA: IDS.b, userB: IDS.c });
        await adapter.create(FRIENDSHIP_SCHEMA, { id: IDS.f3, userA: IDS.c, userB: IDS.d });
        await adapter.create(FRIENDSHIP_SCHEMA, { id: IDS.f4, userA: IDS.d, userB: IDS.e });
    }

    it("homogeneous repeat: depth.max returns users up to N hops", async () => {
        await seedFriendGraph();
        const ctx = makeCtx(USER_SCHEMA, USER_SCHEMA, [FRIENDSHIP_SCHEMA], [USER_SCHEMA]);
        const result = (await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { max: 3 },
            emit: "nodes",
        })) as Rec[];
        assert.deepEqual(result.map((r) => r["id"]).sort(), [IDS.b, IDS.c, IDS.d].sort());
    });

    it("repeat with depth.min skips direct connections", async () => {
        await seedFriendGraph();
        const ctx = makeCtx(USER_SCHEMA, USER_SCHEMA, [FRIENDSHIP_SCHEMA], [USER_SCHEMA]);
        const result = (await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { min: 2, max: 4 },
            emit: "nodes",
        })) as Rec[];
        assert.deepEqual(result.map((r) => r["id"]).sort(), [IDS.c, IDS.d, IDS.e].sort());
    });

    it("repeat with emit: paths returns ordered paths", async () => {
        await seedFriendGraph();
        const ctx = makeCtx(USER_SCHEMA, USER_SCHEMA, [FRIENDSHIP_SCHEMA], [USER_SCHEMA]);
        const result = (await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { min: 1, max: 3 },
            emit: "paths",
        })) as Path[];
        assert.equal(result.length, 3);
        const sorted = result.map((p) => p.nodes.map((n) => n["id"]).join("-")).sort();
        assert.deepEqual(sorted, [
            [IDS.a, IDS.b].join("-"),
            [IDS.a, IDS.b, IDS.c].join("-"),
            [IDS.a, IDS.b, IDS.c, IDS.d].join("-"),
        ].sort());
    });

    it("terminal spec.where filters terminal nodes", async () => {
        await seedFriendGraph();
        const ctx = makeCtx(USER_SCHEMA, USER_SCHEMA, [FRIENDSHIP_SCHEMA], [USER_SCHEMA]);
        const result = (await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.a } },
            repeat: { via: "friendship", direction: "out" },
            depth: { max: 3 },
            where: { id: { $in: [IDS.c, IDS.d] } },
            emit: "nodes",
        })) as Rec[];
        assert.deepEqual(result.map((r) => r["id"]).sort(), [IDS.c, IDS.d].sort());
    });

    it("steps mode + emit: nodes — sort + limit returns a deterministic slice", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, POST_SCHEMA, [AUTHORSHIP_SCHEMA], [USER_SCHEMA, POST_SCHEMA]);
        const result = (await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
            steps: [{ via: "authorship", direction: "out" }],
            emit: "nodes",
            options: { sort: { title: -1 }, limit: 1 },
        })) as Rec[];
        assert.deepEqual(result.map((r) => r["id"]), [IDS.p2]);
    });

    it("steps mode + emit: nodes — sort + skip pages past the first row", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, POST_SCHEMA, [AUTHORSHIP_SCHEMA], [USER_SCHEMA, POST_SCHEMA]);
        const result = (await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
            steps: [{ via: "authorship", direction: "out" }],
            emit: "nodes",
            options: { sort: { title: 1 }, skip: 1 },
        })) as Rec[];
        assert.deepEqual(result.map((r) => r["id"]), [IDS.p2]);
    });

    it("steps mode + emit: edges — sort + limit returns a deterministic slice", async () => {
        await seedAuthorshipGraph();
        const ctx = makeCtx(USER_SCHEMA, POST_SCHEMA, [AUTHORSHIP_SCHEMA], [USER_SCHEMA, POST_SCHEMA]);
        const result = (await adapter.traverse(ctx, {
            start: { schema: "user", where: { id: IDS.alice } },
            steps: [{ via: "authorship", direction: "out" }],
            emit: "edges",
            options: { sort: { id: -1 }, limit: 1 },
        })) as Rec[];
        assert.deepEqual(result.map((r) => r["id"]), [IDS.a2]);
    });
});

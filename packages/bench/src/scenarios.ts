import type {
    KeymaDatabaseAdapter,
    SchemaMetadata,
    TraversalSpec,
} from "@keyma/runtime/schema";
import {
    ALL_SCHEMAS,
    AUTHORSHIP_SCHEMA,
    FRIENDSHIP_SCHEMA,
    ORG_SCHEMA,
    POST_SCHEMA,
    TAG_SCHEMA,
    TAGGING_SCHEMA,
    USER_SCHEMA,
} from "./schemas.js";
import {
    id,
    IdKind,
    mkAuthorship,
    mkFriendChain,
    mkOrgs,
    mkPosts,
    mkTagging,
    mkTags,
    mkUsers,
} from "./generate.js";

export type BenchContext = {
    adapter: KeymaDatabaseAdapter;
    datasetSize: number;
    state: Record<string, unknown>;
};

export type Scenario = {
    name: string;
    description: string;
    iterations?: number;
    warmup?: number;
    setup?(ctx: BenchContext): Promise<void>;
    iteration(ctx: BenchContext, i: number): Promise<void>;
    teardown?(ctx: BenchContext): Promise<void>;
};

const DEFAULT_ITERATIONS = 100;
const DEFAULT_WARMUP = 10;

async function ensureAll(adapter: KeymaDatabaseAdapter): Promise<void> {
    for (const s of ALL_SCHEMAS) await adapter.ensureSchema(s);
}

async function bulkCreate(
    adapter: KeymaDatabaseAdapter,
    schema: SchemaMetadata,
    rows: Record<string, unknown>[],
): Promise<void> {
    for (const r of rows) await adapter.create(schema, r);
}

export const SCENARIOS: readonly Scenario[] = [
    {
        name: "ensureSchema.cold",
        description: "Time to ensureSchema across all 7 bench schemas from empty.",
        iterations: 10,
        warmup: 2,
        async iteration(ctx, i) {
            // Each iteration uses a fresh suffix so collections don't collide.
            const suffix = "_cold_" + i;
            const renamed = ALL_SCHEMAS.map((s) => ({ ...s, name: s.name + suffix }));
            for (const s of renamed) await ctx.adapter.ensureSchema(s);
        },
    },
    {
        name: "create.user",
        description: "Sequential create() of fresh users.",
        async setup(ctx) {
            await ensureAll(ctx.adapter);
        },
        async iteration(ctx, i) {
            // Use a high-numbered id range so we don't collide with seeded data
            // from later setups (each scenario gets its own DB cleanup).
            await ctx.adapter.create(USER_SCHEMA, {
                id: id(IdKind.User, 1_000_000 + i),
                email: "create" + i + "@bench.local",
                name: "create-user-" + i,
            });
        },
    },
    {
        name: "read.user.byId",
        description: "read() one user by id, round-robin across the seeded pool.",
        async setup(ctx) {
            await ensureAll(ctx.adapter);
            await bulkCreate(ctx.adapter, USER_SCHEMA, mkUsers(ctx.datasetSize));
        },
        async iteration(ctx, i) {
            await ctx.adapter.read(USER_SCHEMA, {
                id: id(IdKind.User, i % ctx.datasetSize),
            });
        },
    },
    {
        name: "list.user.filterIndexed",
        description: "list() with where: { email: ... } on the unique email index.",
        async setup(ctx) {
            await ensureAll(ctx.adapter);
            await bulkCreate(ctx.adapter, USER_SCHEMA, mkUsers(ctx.datasetSize));
        },
        async iteration(ctx, i) {
            await ctx.adapter.list(USER_SCHEMA, {
                where: { email: "u" + (i % ctx.datasetSize) + "@bench.local" },
                sort: {},
            });
        },
    },
    {
        name: "list.user.sortLimit",
        description: "list() with sort: { name: 1 }, skip 100, limit 20 over the seeded pool.",
        async setup(ctx) {
            await ensureAll(ctx.adapter);
            await bulkCreate(ctx.adapter, USER_SCHEMA, mkUsers(ctx.datasetSize));
        },
        async iteration(ctx, _i) {
            await ctx.adapter.list(USER_SCHEMA, {
                where: {},
                sort: { name: 1 },
                skip: 100,
                limit: 20,
            });
        },
    },
    {
        name: "update.user.byId",
        description: "update() by id, round-robin across the seeded pool.",
        async setup(ctx) {
            await ensureAll(ctx.adapter);
            await bulkCreate(ctx.adapter, USER_SCHEMA, mkUsers(ctx.datasetSize));
        },
        async iteration(ctx, i) {
            await ctx.adapter.update(
                USER_SCHEMA,
                { id: id(IdKind.User, i % ctx.datasetSize) },
                { name: "updated-" + i },
            );
        },
    },
    {
        name: "delete.user.byId",
        description: "delete() one user per iteration from a pool sized N+warmup.",
        async setup(ctx) {
            await ensureAll(ctx.adapter);
            // Need at least iterations + warmup distinct users.
            const need = (DEFAULT_ITERATIONS + DEFAULT_WARMUP) * 2;
            await bulkCreate(ctx.adapter, USER_SCHEMA, mkUsers(need));
            ctx.state["deletePoolSize"] = need;
        },
        async iteration(ctx, i) {
            await ctx.adapter.delete(USER_SCHEMA, { id: id(IdKind.User, i) });
        },
    },
    {
        name: "populate.user.org",
        description: "read() one user with single-level org populate.",
        async setup(ctx) {
            await ensureAll(ctx.adapter);
            const orgCount = Math.max(1, Math.floor(ctx.datasetSize / 100));
            await bulkCreate(ctx.adapter, ORG_SCHEMA, mkOrgs(orgCount));
            await bulkCreate(ctx.adapter, USER_SCHEMA, mkUsers(ctx.datasetSize, orgCount));
        },
        async iteration(ctx, i) {
            await ctx.adapter.read(
                USER_SCHEMA,
                { id: id(IdKind.User, i % ctx.datasetSize) },
                {
                    populate: {
                        organization: { schema: ORG_SCHEMA },
                    },
                },
            );
        },
    },
    {
        name: "traverse.steps.2hop",
        description: "User → Authorship → Post via traverse() steps mode.",
        async setup(ctx) {
            if (ctx.adapter.traverse === undefined) {
                throw new Error("adapter does not support traverse");
            }
            await ensureAll(ctx.adapter);
            const userCount = Math.max(10, Math.floor(ctx.datasetSize / 10));
            const postCount = ctx.datasetSize;
            await bulkCreate(ctx.adapter, USER_SCHEMA, mkUsers(userCount));
            await bulkCreate(ctx.adapter, POST_SCHEMA, mkPosts(postCount));
            await bulkCreate(ctx.adapter, AUTHORSHIP_SCHEMA, mkAuthorship(userCount, postCount));
            ctx.state["userCount"] = userCount;
        },
        async iteration(ctx, i) {
            const userCount = ctx.state["userCount"] as number;
            const spec: TraversalSpec = {
                start: { schema: USER_SCHEMA.name, where: { id: id(IdKind.User, i % userCount) } },
                steps: [{ via: AUTHORSHIP_SCHEMA.name, direction: "out" }],
                emit: "nodes",
            };
            await ctx.adapter.traverse!(traverseCtx(USER_SCHEMA, POST_SCHEMA, [AUTHORSHIP_SCHEMA]), spec);
        },
    },
    {
        name: "traverse.steps.3hop",
        description: "User → Authorship → Post → Tagging → Tag via traverse() steps mode.",
        async setup(ctx) {
            if (ctx.adapter.traverse === undefined) {
                throw new Error("adapter does not support traverse");
            }
            await ensureAll(ctx.adapter);
            const userCount = Math.max(10, Math.floor(ctx.datasetSize / 10));
            const postCount = ctx.datasetSize;
            const tagCount = Math.max(10, Math.floor(ctx.datasetSize / 100));
            await bulkCreate(ctx.adapter, USER_SCHEMA, mkUsers(userCount));
            await bulkCreate(ctx.adapter, POST_SCHEMA, mkPosts(postCount));
            await bulkCreate(ctx.adapter, TAG_SCHEMA, mkTags(tagCount));
            await bulkCreate(ctx.adapter, AUTHORSHIP_SCHEMA, mkAuthorship(userCount, postCount));
            await bulkCreate(ctx.adapter, TAGGING_SCHEMA, mkTagging(postCount, tagCount));
            ctx.state["userCount"] = userCount;
        },
        async iteration(ctx, i) {
            const userCount = ctx.state["userCount"] as number;
            const spec: TraversalSpec = {
                start: { schema: USER_SCHEMA.name, where: { id: id(IdKind.User, i % userCount) } },
                steps: [
                    { via: AUTHORSHIP_SCHEMA.name, direction: "out" },
                    { via: TAGGING_SCHEMA.name, direction: "out" },
                ],
                emit: "nodes",
            };
            await ctx.adapter.traverse!(
                traverseCtx(USER_SCHEMA, TAG_SCHEMA, [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA], [POST_SCHEMA]),
                spec,
            );
        },
    },
    {
        name: "traverse.repeat.depth3",
        description: "User → Friendship+ depth=3 via traverse() repeat mode.",
        async setup(ctx) {
            if (ctx.adapter.traverse === undefined) {
                throw new Error("adapter does not support traverse");
            }
            await ensureAll(ctx.adapter);
            const userCount = Math.max(20, Math.floor(ctx.datasetSize / 50));
            await bulkCreate(ctx.adapter, USER_SCHEMA, mkUsers(userCount));
            await bulkCreate(ctx.adapter, FRIENDSHIP_SCHEMA, mkFriendChain(userCount));
            ctx.state["userCount"] = userCount;
        },
        async iteration(ctx, i) {
            const userCount = ctx.state["userCount"] as number;
            const spec: TraversalSpec = {
                start: { schema: USER_SCHEMA.name, where: { id: id(IdKind.User, i % userCount) } },
                repeat: { via: FRIENDSHIP_SCHEMA.name, direction: "out" },
                depth: { max: 3 },
                emit: "nodes",
            };
            await ctx.adapter.traverse!(
                traverseCtx(USER_SCHEMA, USER_SCHEMA, [FRIENDSHIP_SCHEMA]),
                spec,
            );
        },
    },
    {
        name: "traverse.emit.paths",
        description: "User → Authorship → Post → Tagging → Tag with emit: paths.",
        async setup(ctx) {
            if (ctx.adapter.traverse === undefined) {
                throw new Error("adapter does not support traverse");
            }
            await ensureAll(ctx.adapter);
            const userCount = Math.max(10, Math.floor(ctx.datasetSize / 10));
            const postCount = ctx.datasetSize;
            const tagCount = Math.max(10, Math.floor(ctx.datasetSize / 100));
            await bulkCreate(ctx.adapter, USER_SCHEMA, mkUsers(userCount));
            await bulkCreate(ctx.adapter, POST_SCHEMA, mkPosts(postCount));
            await bulkCreate(ctx.adapter, TAG_SCHEMA, mkTags(tagCount));
            await bulkCreate(ctx.adapter, AUTHORSHIP_SCHEMA, mkAuthorship(userCount, postCount));
            await bulkCreate(ctx.adapter, TAGGING_SCHEMA, mkTagging(postCount, tagCount));
            ctx.state["userCount"] = userCount;
        },
        async iteration(ctx, i) {
            const userCount = ctx.state["userCount"] as number;
            const spec: TraversalSpec = {
                start: { schema: USER_SCHEMA.name, where: { id: id(IdKind.User, i % userCount) } },
                steps: [
                    { via: AUTHORSHIP_SCHEMA.name, direction: "out" },
                    { via: TAGGING_SCHEMA.name, direction: "out" },
                ],
                emit: "paths",
            };
            await ctx.adapter.traverse!(
                traverseCtx(USER_SCHEMA, TAG_SCHEMA, [AUTHORSHIP_SCHEMA, TAGGING_SCHEMA], [POST_SCHEMA]),
                spec,
            );
        },
    },
];

function traverseCtx(
    start: SchemaMetadata,
    terminal: SchemaMetadata,
    edges: SchemaMetadata[],
    extraNodes: SchemaMetadata[] = [],
): import("@keyma/runtime/schema").AdapterTraversalContext {
    const nodes = new Map<string, SchemaMetadata>();
    nodes.set(start.name, start);
    nodes.set(terminal.name, terminal);
    for (const n of extraNodes) nodes.set(n.name, n);
    return {
        startSchema: start,
        terminalSchema: terminal,
        edges: new Map(edges.map((e) => [e.name, e])),
        nodes,
    };
}

export { DEFAULT_ITERATIONS, DEFAULT_WARMUP };

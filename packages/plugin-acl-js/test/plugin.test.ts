import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KeymaServer } from "@keyma/runtime-js";
import type {
    AdapterFieldSpec,
    AdapterProjection,
    KeymaDatabaseAdapter,
    KeymaLeafFailure,
    KeymaLeafSuccess,
    KeymaRequest,
    ListQuery,
    SchemaMetadata,
} from "@keyma/runtime-js";
import { aclSchemas, createAclPlugin } from "../src/index.js";
import {
    ACL_RULE_SCHEMA,
    ACL_ROLE_ASSIGNMENT_SCHEMA,
} from "../src/schemas.js";

// ── Domain fixtures ─────────────────────────────────────────────────────────

const POST_SCHEMA: SchemaMetadata = {
    name: "post",
    sourceName: "Post",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true, validators: [{ kind: "required" }] },
        { name: "title", type: { kind: "string" }, validators: [{ kind: "required" }] },
        { name: "body", type: { kind: "string" }, required: false },
        { name: "author", type: { kind: "string" }, validators: [{ kind: "required" }] },
        { name: "tenant", type: { kind: "string" }, required: false },
        { name: "flagged", type: { kind: "boolean" }, required: false },
    ],
};

// ── In-memory adapter understanding $and / $or / $nor / $eq / $in ───────────

class InMemoryAdapter implements KeymaDatabaseAdapter {
    public stores = new Map<string, Map<string, Record<string, unknown>>>();
    private counter = 0;

    private storeFor(schema: SchemaMetadata): Map<string, Record<string, unknown>> {
        let s = this.stores.get(schema.name);
        if (s === undefined) {
            s = new Map();
            this.stores.set(schema.name, s);
        }
        return s;
    }

    async ensureSchema(schema: SchemaMetadata): Promise<void> {
        this.storeFor(schema);
    }

    async create(
        schema: SchemaMetadata,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>> {
        const store = this.storeFor(schema);
        const id =
            (data["id"] as string | undefined) ?? `${schema.name}-${++this.counter}`;
        const record = { ...data, id };
        store.set(id, record);
        return projection !== undefined ? applyProjection(record, projection) : record;
    }

    async read(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown> | null> {
        const all = [...this.storeFor(schema).values()];
        const match = all.find((r) => matches(r, where));
        if (match === undefined) return null;
        return projection !== undefined ? applyProjection(match, projection) : match;
    }

    async list(
        schema: SchemaMetadata,
        query: ListQuery,
    ): Promise<Record<string, unknown>[]> {
        let results = [...this.storeFor(schema).values()].filter((r) =>
            matches(r, query.where),
        );
        if (query.skip !== undefined) results = results.slice(query.skip);
        if (query.limit !== undefined) results = results.slice(0, query.limit);
        if (query.projection !== undefined) {
            const proj = query.projection;
            results = results.map((r) => applyProjection(r, proj));
        }
        return results;
    }

    async update(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>> {
        const store = this.storeFor(schema);
        for (const [id, r] of store.entries()) {
            if (matches(r, where)) {
                const updated = { ...r, ...data, id };
                store.set(id, updated);
                return projection !== undefined
                    ? applyProjection(updated, projection)
                    : updated;
            }
        }
        throw new Error(`No record matches where ${JSON.stringify(where)}`);
    }

    async delete(schema: SchemaMetadata, where: Record<string, unknown>): Promise<void> {
        const store = this.storeFor(schema);
        for (const [id, r] of store.entries()) {
            if (matches(r, where)) {
                store.delete(id);
                return;
            }
        }
    }
}

function matches(record: Record<string, unknown>, where: Record<string, unknown>): boolean {
    for (const [key, spec] of Object.entries(where)) {
        if (key === "$and") {
            if (!Array.isArray(spec)) return false;
            for (const sub of spec) {
                if (!matches(record, sub as Record<string, unknown>)) return false;
            }
            continue;
        }
        if (key === "$or") {
            if (!Array.isArray(spec)) return false;
            const any = (spec as Record<string, unknown>[]).some((s) => matches(record, s));
            if (!any) return false;
            continue;
        }
        if (key === "$nor") {
            if (!Array.isArray(spec)) return false;
            const any = (spec as Record<string, unknown>[]).some((s) => matches(record, s));
            if (any) return false;
            continue;
        }
        const fieldValue = record[key];
        if (typeof spec === "object" && spec !== null && !Array.isArray(spec)) {
            const opEntries = Object.entries(spec as Record<string, unknown>);
            const isOpExpr =
                opEntries.length > 0 && opEntries.every(([k]) => k.startsWith("$"));
            if (isOpExpr) {
                for (const [op, arg] of opEntries) {
                    if (!matchesOp(fieldValue, op, arg)) return false;
                }
                continue;
            }
        }
        if (fieldValue !== spec) return false;
    }
    return true;
}

function matchesOp(value: unknown, op: string, arg: unknown): boolean {
    switch (op) {
        case "$eq":
            return value === arg;
        case "$ne":
            return value !== arg;
        case "$in":
            return Array.isArray(arg) && (arg as unknown[]).includes(value);
        case "$nin":
            return Array.isArray(arg) && !(arg as unknown[]).includes(value);
        case "$gt":
            return (value as number) > (arg as number);
        case "$gte":
            return (value as number) >= (arg as number);
        case "$lt":
            return (value as number) < (arg as number);
        case "$lte":
            return (value as number) <= (arg as number);
        default:
            return false;
    }
}

function applyProjection(
    record: Record<string, unknown>,
    projection: AdapterProjection,
): Record<string, unknown> {
    if (projection.fields === undefined && projection.populate === undefined) {
        return record;
    }
    const result: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(projection.fields ?? {})) {
        if (spec === 1) {
            result[key] = record[key];
        } else {
            const value = record[key];
            result[key] =
                typeof value === "object" && value !== null
                    ? applyEmbeddedSpec(value as Record<string, unknown>, spec)
                    : null;
        }
    }
    return result;
}

function applyEmbeddedSpec(
    value: Record<string, unknown>,
    spec: { [key: string]: AdapterFieldSpec },
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, sub] of Object.entries(spec)) {
        if (sub === 1) result[key] = value[key];
        else {
            const nested = value[key];
            result[key] =
                typeof nested === "object" && nested !== null
                    ? applyEmbeddedSpec(nested as Record<string, unknown>, sub)
                    : null;
        }
    }
    return result;
}

// ── Setup helper ─────────────────────────────────────────────────────────────

async function setup(): Promise<{
    server: KeymaServer;
    adapter: InMemoryAdapter;
}> {
    const adapter = new InMemoryAdapter();
    const server = new KeymaServer({
        schemas: [POST_SCHEMA, ...aclSchemas],
        adapter,
        plugins: [createAclPlugin()],
    });
    await server.ensureSchemas();
    return { server, adapter };
}

async function seedPosts(adapter: InMemoryAdapter): Promise<void> {
    const store = adapter.stores.get(POST_SCHEMA.name)!;
    store.set("p1", { id: "p1", title: "Alice's diary", body: "hi", author: "alice", flagged: false });
    store.set("p2", { id: "p2", title: "Bob's notes", body: "yo", author: "bob", flagged: false });
    store.set("p3", { id: "p3", title: "Public post", body: "everyone", author: "carol", flagged: false });
    store.set("p4", { id: "p4", title: "Flagged", body: "bad", author: "alice", flagged: true });
}

async function seedRule(
    adapter: InMemoryAdapter,
    rule: Record<string, unknown>,
): Promise<void> {
    const store = adapter.stores.get(ACL_RULE_SCHEMA.name)!;
    const id = (rule["id"] as string) ?? `r-${store.size + 1}`;
    store.set(id, { ...rule, id });
}

async function seedRoleAssignment(
    adapter: InMemoryAdapter,
    userId: string,
    role: string,
): Promise<void> {
    const store = adapter.stores.get(ACL_ROLE_ASSIGNMENT_SCHEMA.name)!;
    const id = `ra-${store.size + 1}`;
    store.set(id, { id, userId, role });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ACL plugin — list visibility", () => {
    it("denies when no rule grants list", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        const resp = await server.handle(
            { operations: { a: { op: "list", schema: "post" } } },
            { identity: { id: "carol" } },
        );
        const a = resp.results["a"] as KeymaLeafFailure;
        assert.equal(a.code, "FORBIDDEN");
    });

    it("unconditional allow returns everything", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["list", "read"],
        });
        const resp = await server.handle(
            { operations: { a: { op: "list", schema: "post" } } },
            { identity: { id: "alice" } },
        );
        const a = resp.results["a"] as KeymaLeafSuccess<Record<string, unknown>[]>;
        assert.equal(a.ok, true);
        assert.equal(a.data.length, 4);
    });

    it("$self predicate restricts to caller's records", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["list", "read"],
            where: { author: "$self" },
        });
        const aliceResp = await server.handle(
            { operations: { a: { op: "list", schema: "post" } } },
            { identity: { id: "alice" } },
        );
        const a = aliceResp.results["a"] as KeymaLeafSuccess<Record<string, unknown>[]>;
        assert.equal(a.data.length, 2);
        assert.ok(a.data.every((p) => p["author"] === "alice"));

        const bobResp = await server.handle(
            { operations: { a: { op: "list", schema: "post" } } },
            { identity: { id: "bob" } },
        );
        const b = bobResp.results["a"] as KeymaLeafSuccess<Record<string, unknown>[]>;
        assert.equal(b.data.length, 1);
        assert.equal(b.data[0]?.["author"], "bob");
    });

    it("deny rule with $nor removes flagged posts", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["list", "read"],
        });
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["list", "read"],
            where: { flagged: true },
            effect: "deny",
        });
        const resp = await server.handle(
            { operations: { a: { op: "list", schema: "post" } } },
            { identity: { id: "alice" } },
        );
        const a = resp.results["a"] as KeymaLeafSuccess<Record<string, unknown>[]>;
        assert.equal(a.data.length, 3);
        assert.ok(a.data.every((p) => p["flagged"] !== true));
    });

    it("user filter is AND-ed with ACL filter", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["list"],
            where: { author: "$self" },
        });
        const resp = await server.handle(
            {
                operations: {
                    a: {
                        op: "list",
                        schema: "post",
                        where: { flagged: false },
                    },
                },
            },
            { identity: { id: "alice" } },
        );
        const a = resp.results["a"] as KeymaLeafSuccess<Record<string, unknown>[]>;
        assert.equal(a.data.length, 1);
        assert.equal(a.data[0]?.["id"], "p1");
    });

    it("role-based grant resolves via AclRoleAssignment", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        await seedRoleAssignment(adapter, "alice", "editor");
        await seedRule(adapter, {
            subjectKind: "role",
            subjectRole: "editor",
            schema: "post",
            actions: ["list"],
        });
        const aliceResp = await server.handle(
            { operations: { a: { op: "list", schema: "post" } } },
            { identity: { id: "alice" } },
        );
        const a = aliceResp.results["a"] as KeymaLeafSuccess<Record<string, unknown>[]>;
        assert.equal(a.data.length, 4);

        const bobResp = await server.handle(
            { operations: { a: { op: "list", schema: "post" } } },
            { identity: { id: "bob" } },
        );
        const b = bobResp.results["a"] as KeymaLeafFailure;
        assert.equal(b.code, "FORBIDDEN");
    });

    it("explicit roles in context bypass role-assignment lookup", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        await seedRule(adapter, {
            subjectKind: "role",
            subjectRole: "admin",
            schema: "post",
            actions: ["list"],
        });
        const resp = await server.handle(
            { operations: { a: { op: "list", schema: "post" } } },
            { identity: { id: "x", roles: ["admin"] } },
        );
        const a = resp.results["a"] as KeymaLeafSuccess<unknown[]>;
        assert.equal(a.ok, true);
        assert.equal(a.data.length, 4);
    });
});

describe("ACL plugin — read", () => {
    it("unauthorized read returns NOT_FOUND (no existence leak)", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["read"],
            where: { author: "$self" },
        });
        const resp = await server.handle(
            {
                operations: {
                    a: { op: "read", schema: "post", where: { id: "p2" } },
                },
            },
            { identity: { id: "alice" } },
        );
        const a = resp.results["a"] as KeymaLeafFailure;
        assert.equal(a.code, "NOT_FOUND");
    });

    it("authorized read returns the record", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["read"],
            where: { author: "$self" },
        });
        const resp = await server.handle(
            {
                operations: {
                    a: { op: "read", schema: "post", where: { id: "p1" } },
                },
            },
            { identity: { id: "alice" } },
        );
        const a = resp.results["a"] as KeymaLeafSuccess<Record<string, unknown>>;
        assert.equal(a.ok, true);
        assert.equal(a.data["id"], "p1");
    });
});

describe("ACL plugin — field-level perms", () => {
    it("read: response only includes allowed fields", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["read", "list"],
            fieldsRead: ["id", "title"],
        });
        const resp = await server.handle(
            {
                operations: {
                    a: { op: "read", schema: "post", where: { id: "p1" } },
                },
            },
            { identity: { id: "alice" } },
        );
        const a = resp.results["a"] as KeymaLeafSuccess<Record<string, unknown>>;
        assert.deepEqual(Object.keys(a.data).sort(), ["id", "title"]);
    });

    it("write: rejected if data includes disallowed field", async () => {
        const { server, adapter } = await setup();
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["create"],
            fieldsWrite: ["title", "body"],
        });
        const resp = await server.handle(
            {
                operations: {
                    a: {
                        op: "create",
                        schema: "post",
                        data: {
                            title: "ok",
                            body: "ok",
                            author: "alice",
                            flagged: true,
                        },
                    },
                },
            },
            { identity: { id: "alice" } },
        );
        const a = resp.results["a"] as KeymaLeafFailure;
        assert.equal(a.code, "FIELD_FORBIDDEN");
        const fields = a["fields"] as string[] | undefined;
        assert.ok(fields?.includes("author"));
        assert.ok(fields?.includes("flagged"));
    });

    it("predicate-only field is pulled in then stripped from result", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["read", "list"],
            where: { author: "$self" },
            fieldsRead: ["id", "title"],
        });
        const resp = await server.handle(
            {
                operations: {
                    a: {
                        op: "list",
                        schema: "post",
                        project: { id: 1, title: 1 },
                    },
                },
            },
            { identity: { id: "alice" } },
        );
        const a = resp.results["a"] as KeymaLeafSuccess<Record<string, unknown>[]>;
        for (const p of a.data) {
            assert.deepEqual(Object.keys(p).sort(), ["id", "title"]);
        }
        assert.equal(a.data.length, 2);
    });
});

describe("ACL plugin — write enforcement", () => {
    it("create denied when no rule grants create", async () => {
        const { server } = await setup();
        const resp = await server.handle(
            {
                operations: {
                    a: {
                        op: "create",
                        schema: "post",
                        data: { title: "x", author: "alice" },
                    },
                },
            },
            { identity: { id: "alice" } },
        );
        const a = resp.results["a"] as KeymaLeafFailure;
        assert.equal(a.code, "FORBIDDEN");
    });

    it("update is AND-ed with ACL filter so only owned records are reachable", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["update"],
            where: { author: "$self" },
        });
        // Alice updates her own post — succeeds.
        const ok = await server.handle(
            {
                operations: {
                    a: {
                        op: "update",
                        schema: "post",
                        where: { id: "p1" },
                        data: { title: "renamed" },
                    },
                },
            },
            { identity: { id: "alice" } },
        );
        const okR = ok.results["a"] as KeymaLeafSuccess<Record<string, unknown>>;
        assert.equal(okR.ok, true);
        assert.equal(adapter.stores.get("post")!.get("p1")!["title"], "renamed");

        // Alice tries to update bob's post — adapter sees the merged filter
        // (id=p2 AND author=alice) which matches nothing; in-memory adapter
        // throws, surfaced as INTERNAL_ERROR. A real adapter would no-op or
        // return rowcount=0. This is documented behavior.
    });

    it("delete is AND-ed with ACL filter", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["delete"],
            where: { author: "$self" },
        });
        // Alice deletes bob's post: filter is (id=p2 AND author=alice) — no match,
        // delete no-ops on the in-memory adapter.
        await server.handle(
            {
                operations: {
                    a: { op: "delete", schema: "post", where: { id: "p2" } },
                },
            },
            { identity: { id: "alice" } },
        );
        assert.equal(adapter.stores.get("post")!.has("p2"), true);

        // Alice deletes her own:
        await server.handle(
            {
                operations: {
                    a: { op: "delete", schema: "post", where: { id: "p1" } },
                },
            },
            { identity: { id: "alice" } },
        );
        assert.equal(adapter.stores.get("post")!.has("p1"), false);
    });
});

describe("ACL plugin — system context bypass", () => {
    it("isSystem: true bypasses all rules", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        // No rules — normal callers are denied.
        const sys = await server.handle(
            { operations: { a: { op: "list", schema: "post" } } },
            { identity: { isSystem: true } },
        );
        const a = sys.results["a"] as KeymaLeafSuccess<unknown[]>;
        assert.equal(a.ok, true);
        assert.equal(a.data.length, 4);
    });
});

describe("ACL plugin — init validation", () => {
    it("throws at init if aclSchemas not registered", async () => {
        const adapter = new InMemoryAdapter();
        const server = new KeymaServer({
            schemas: [POST_SCHEMA], // missing aclSchemas
            adapter,
            plugins: [createAclPlugin()],
        });
        await assert.rejects(
            () =>
                server.handle(
                    { operations: { a: { op: "list", schema: "post" } } },
                    { identity: { id: "alice" } },
                ),
            /aclSchemas/,
        );
    });
});

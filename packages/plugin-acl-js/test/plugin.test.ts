import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KeymaServer } from "@keyma/runtime-js";
import { InMemoryAdapter } from "@keyma/runtime-js/testing";
import type {
    KeymaLeafFailure,
    KeymaLeafSuccess,
    KeymaOperation,
    PluginServerHandle,
    RequestContext,
    SchemaMetadata,
} from "@keyma/runtime-js";
import {
    KeymaAclAdmin,
    KeymaAclRoleInUse,
    KeymaAclUnknownRole,
    createAclPlugin,
} from "../src/index.js";
import {
    ACL_ROLE_ASSIGNMENT_SCHEMA,
    ACL_ROLE_SCHEMA,
    ACL_RULE_SCHEMA,
    aclSchemas,
} from "../src/schemas.js";

// ── Domain fixtures ─────────────────────────────────────────────────────────

const POST_SCHEMA: SchemaMetadata = {
    name: "post",
    sourceName: "Post",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "title", type: { kind: "string" } },
        { name: "body", type: { kind: "string" }, required: false },
        { name: "author", type: { kind: "string" } },
        { name: "tenant", type: { kind: "string" }, required: false },
        { name: "flagged", type: { kind: "boolean" }, required: false },
    ],
};

// ── Setup helper ─────────────────────────────────────────────────────────────

async function setup(): Promise<{
    server: KeymaServer;
    adapter: InMemoryAdapter;
    admin: KeymaAclAdmin;
}> {
    const adapter = new InMemoryAdapter();
    const plugin = createAclPlugin({});
    const server = new KeymaServer({
        schemas: [POST_SCHEMA],
        adapter,
        plugins: [plugin],
    });
    await server.ensureSchemas();
    const admin = new KeymaAclAdmin(adapter);
    return { server, adapter, admin };
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
            actions: ["read"],
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
            actions: ["read"],
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
            actions: ["read"],
        });
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["read"],
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
            actions: ["read"],
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
            actions: ["read"],
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
            actions: ["read"],
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

describe("ACL plugin — read consolidation", () => {
    it("a single 'read' rule grants both read and list operations", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["read"],
        });

        const listResp = await server.handle(
            { operations: { a: { op: "list", schema: "post" } } },
            { identity: { id: "alice" } },
        );
        const list = listResp.results["a"] as KeymaLeafSuccess<Record<string, unknown>[]>;
        assert.equal(list.ok, true);
        assert.equal(list.data.length, 4);

        const readResp = await server.handle(
            {
                operations: {
                    a: { op: "read", schema: "post", where: { id: "p1" } },
                },
            },
            { identity: { id: "alice" } },
        );
        const read = readResp.results["a"] as KeymaLeafSuccess<Record<string, unknown>>;
        assert.equal(read.ok, true);
        assert.equal(read.data["id"], "p1");
    });
});

describe("ACL plugin — traverse enforcement", () => {
    // The traverse op never runs transformFilter; the plugin enforces row-level
    // read rules via transformOperation. The in-memory adapter doesn't implement
    // traverse, so we exercise transformOperation directly.
    async function makePlugin(): Promise<{
        plugin: ReturnType<typeof createAclPlugin>;
        adapter: InMemoryAdapter;
    }> {
        const adapter = new InMemoryAdapter();
        const plugin = createAclPlugin({});
        const handle: PluginServerHandle = {
            schemas: [POST_SCHEMA],
            adapter,
            schema: (name) => (name === POST_SCHEMA.name ? POST_SCHEMA : undefined),
            addSchema: async (s) => {
                await adapter.ensureSchema(s);
            },
        };
        await plugin.init(handle);
        return { plugin, adapter };
    }

    it("injects read predicates into start and terminal where clauses", async () => {
        const { plugin, adapter } = await makePlugin();
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["read"],
            where: { author: "$self" },
        });
        const op: KeymaOperation = {
            op: "traverse",
            schema: "post",
            spec: {
                start: { schema: "post", where: { id: "p1" } },
                emit: "nodes",
            },
        };
        const ctx: RequestContext = { identity: { id: "alice" } };
        const out = await plugin.transformOperation(ctx, op);
        assert.ok(out !== undefined);
        const spec = (out as Extract<KeymaOperation, { op: "traverse" }>).spec;
        assert.deepEqual(spec.start.where, {
            $and: [{ id: "p1" }, { author: "alice" }],
        });
        assert.deepEqual(spec.where, { author: "alice" });
    });

    it("denies traverse when no read rule grants the schema", async () => {
        const { plugin } = await makePlugin();
        const op: KeymaOperation = {
            op: "traverse",
            schema: "post",
            spec: {
                start: { schema: "post", where: {} },
                emit: "nodes",
            },
        };
        const ctx: RequestContext = { identity: { id: "alice" } };
        await assert.rejects(
            () => Promise.resolve(plugin.transformOperation(ctx, op)),
            /No ACL rule grants/,
        );
    });
});

describe("ACL plugin — field-level perms", () => {
    it("read: response only includes allowed fields", async () => {
        const { server, adapter } = await setup();
        await seedPosts(adapter);
        await seedRule(adapter, {
            subjectKind: "any-user",
            schema: "post",
            actions: ["read"],
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
            actions: ["read"],
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
        const sys = await server.handle(
            { operations: { a: { op: "list", schema: "post" } } },
            { identity: { isSystem: true } },
        );
        const a = sys.results["a"] as KeymaLeafSuccess<unknown[]>;
        assert.equal(a.ok, true);
        assert.equal(a.data.length, 4);
    });
});

describe("ACL plugin — storage privacy", () => {
    for (const schemaName of [
        ACL_RULE_SCHEMA.name,
        ACL_ROLE_SCHEMA.name,
        ACL_ROLE_ASSIGNMENT_SCHEMA.name,
    ]) {
        it(`host server cannot route operations to "${schemaName}" for non-system identities`, async () => {
            const { server } = await setup();
            const resp = await server.handle(
                { operations: { a: { op: "list", schema: schemaName } } },
                { identity: { id: "alice" } },
            );
            const a = resp.results["a"] as KeymaLeafFailure;
            assert.equal(a.ok, false);
            assert.equal(a.code, "SCHEMA_NOT_FOUND");
        });
    }
});

describe("KeymaAclAdmin — rules", () => {
    it("addRule round-trips through getRule", async () => {
        const { admin } = await setup();
        const rule = await admin.addRule({
            subject: { kind: "any-user" },
            schema: "post",
            actions: ["read"],
            where: { author: "$self" },
        });
        assert.equal(typeof rule.id, "string");
        assert.ok(rule.id.length > 0);
        const fetched = await admin.getRule(rule.id);
        assert.deepEqual(fetched, rule);
    });

    it("addRule assigns an id via the adapter (not client-generated)", async () => {
        const { admin } = await setup();
        const a = await admin.addRule({
            subject: { kind: "anon" },
            schema: "post",
            actions: ["read"],
        });
        const b = await admin.addRule({
            subject: { kind: "anon" },
            schema: "post",
            actions: ["create"],
        });
        assert.notEqual(a.id, b.id);
    });

    it("addRule with role subject throws KeymaAclUnknownRole if role isn't declared", async () => {
        const { admin } = await setup();
        await assert.rejects(
            () =>
                admin.addRule({
                    subject: { kind: "role", name: "ghost" },
                    schema: "post",
                    actions: ["read"],
                }),
            (err) => err instanceof KeymaAclUnknownRole,
        );
    });

    it("addRule with role subject succeeds once the role is declared", async () => {
        const { admin } = await setup();
        await admin.addRole("editor");
        const rule = await admin.addRule({
            subject: { kind: "role", name: "editor" },
            schema: "post",
            actions: ["read"],
        });
        assert.deepEqual(rule.subject, { kind: "role", name: "editor" });
    });

    it("updateRule merges patch correctly", async () => {
        const { admin } = await setup();
        const rule = await admin.addRule({
            subject: { kind: "any-user" },
            schema: "post",
            actions: ["read"],
        });
        const updated = await admin.updateRule(rule.id, {
            actions: ["read", "create", "update"],
        });
        assert.deepEqual([...updated.actions].sort(), ["create", "read", "update"]);
        assert.deepEqual(updated.subject, { kind: "any-user" });
        assert.equal(updated.schema, "post");
    });

    it("updateRule rejects unknown ids", async () => {
        const { admin } = await setup();
        await assert.rejects(
            () => admin.updateRule("does-not-exist", { actions: ["read"] }),
            /not found/,
        );
    });

    it("removeRule makes getRule return null", async () => {
        const { admin } = await setup();
        const rule = await admin.addRule({
            subject: { kind: "anon" },
            schema: "post",
            actions: ["read"],
        });
        await admin.removeRule(rule.id);
        assert.equal(await admin.getRule(rule.id), null);
    });

    it("listRules filters by schema and by subject", async () => {
        const { admin } = await setup();
        await admin.addRole("editor");
        await admin.addRule({ subject: { kind: "any-user" }, schema: "post", actions: ["read"] });
        await admin.addRule({ subject: { kind: "any-user" }, schema: "comment", actions: ["read"] });
        await admin.addRule({ subject: { kind: "role", name: "editor" }, schema: "post", actions: ["update"] });

        const postRules = await admin.listRules({ schema: "post" });
        assert.equal(postRules.length, 2);

        const editorRules = await admin.listRules({
            subject: { kind: "role", name: "editor" },
        });
        assert.equal(editorRules.length, 1);
        assert.deepEqual(editorRules[0]?.subject, { kind: "role", name: "editor" });
    });
});

describe("KeymaAclAdmin — roles (catalog)", () => {
    it("addRole is idempotent", async () => {
        const { admin } = await setup();
        const first = await admin.addRole("admin");
        const second = await admin.addRole("admin");
        assert.equal(first.id, second.id);
        assert.equal(first.name, "admin");
    });

    it("getRole returns the record or null", async () => {
        const { admin } = await setup();
        assert.equal(await admin.getRole("missing"), null);
        const created = await admin.addRole("admin");
        const fetched = await admin.getRole("admin");
        assert.deepEqual(fetched, created);
    });

    it("listRoles enumerates", async () => {
        const { admin } = await setup();
        await admin.addRole("admin");
        await admin.addRole("editor");
        const names = (await admin.listRoles()).map((r) => r.name).sort();
        assert.deepEqual(names, ["admin", "editor"]);
    });

    it("removeRole succeeds when nothing references it", async () => {
        const { admin } = await setup();
        await admin.addRole("admin");
        await admin.removeRole("admin");
        assert.equal(await admin.getRole("admin"), null);
    });

    it("removeRole is silent when the role doesn't exist", async () => {
        const { admin } = await setup();
        await admin.removeRole("never-existed"); // does not throw
    });

    it("removeRole throws KeymaAclRoleInUse when an assignment references it", async () => {
        const { admin } = await setup();
        await admin.addRole("admin");
        await admin.assignRole("alice", "admin");
        await assert.rejects(
            () => admin.removeRole("admin"),
            (err) => {
                if (!(err instanceof KeymaAclRoleInUse)) return false;
                assert.equal(err.role, "admin");
                assert.equal(err.assignmentIds.length, 1);
                assert.equal(err.ruleIds.length, 0);
                return true;
            },
        );
    });

    it("removeRole throws KeymaAclRoleInUse when a rule references it", async () => {
        const { admin } = await setup();
        await admin.addRole("editor");
        const rule = await admin.addRule({
            subject: { kind: "role", name: "editor" },
            schema: "post",
            actions: ["update"],
        });
        await assert.rejects(
            () => admin.removeRole("editor"),
            (err) => {
                if (!(err instanceof KeymaAclRoleInUse)) return false;
                assert.deepEqual(err.ruleIds, [rule.id]);
                return true;
            },
        );
    });
});

describe("KeymaAclAdmin — role assignments", () => {
    it("assignRole throws KeymaAclUnknownRole if role isn't declared", async () => {
        const { admin } = await setup();
        await assert.rejects(
            () => admin.assignRole("alice", "admin"),
            (err) => err instanceof KeymaAclUnknownRole,
        );
    });

    it("assignRole is idempotent after the role is declared", async () => {
        const { admin } = await setup();
        await admin.addRole("admin");
        const first = await admin.assignRole("alice", "admin");
        const second = await admin.assignRole("alice", "admin");
        assert.equal(first.id, second.id);
        const all = await admin.listAssignments({ userId: "alice", role: "admin" });
        assert.equal(all.length, 1);
    });

    it("unassignRole removes only the matching pair", async () => {
        const { admin } = await setup();
        await admin.addRole("admin");
        await admin.addRole("editor");
        await admin.assignRole("alice", "admin");
        await admin.assignRole("alice", "editor");
        await admin.unassignRole("alice", "admin");
        const aliceRoles = (await admin.getUserRoles("alice")).sort();
        assert.deepEqual(aliceRoles, ["editor"]);
    });

    it("getUserRoles and listAssignments work", async () => {
        const { admin } = await setup();
        await admin.addRole("admin");
        await admin.addRole("editor");
        await admin.assignRole("alice", "admin");
        await admin.assignRole("alice", "editor");
        await admin.assignRole("bob", "admin");

        const alice = (await admin.getUserRoles("alice")).sort();
        assert.deepEqual(alice, ["admin", "editor"]);

        const admins = await admin.listAssignments({ role: "admin" });
        const userIds = admins.map((a) => a.userId).sort();
        assert.deepEqual(userIds, ["alice", "bob"]);
    });

    it("rule written via admin is then enforced by the host server", async () => {
        const { server, adapter, admin } = await setup();
        await seedPosts(adapter);
        await admin.addRule({
            subject: { kind: "any-user" },
            schema: "post",
            actions: ["read"],
            where: { author: "$self" },
        });
        const resp = await server.handle(
            { operations: { a: { op: "list", schema: "post" } } },
            { identity: { id: "alice" } },
        );
        const a = resp.results["a"] as KeymaLeafSuccess<Record<string, unknown>[]>;
        assert.equal(a.ok, true);
        assert.equal(a.data.length, 2);
        assert.ok(a.data.every((p) => p["author"] === "alice"));
    });
});

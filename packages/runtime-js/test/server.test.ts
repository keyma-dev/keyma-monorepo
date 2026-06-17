import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KeymaServer } from "../src/server.js";
import { InMemoryAdapter } from "../src/testing.js";
import type { KeymaRequest, KeymaLeafFailure, KeymaLeafSuccess } from "../src/protocol.js";
import type { ValidatorRegistry } from "../src/validate.js";
import type { FormatterRegistry } from "../src/format.js";
import {
    USER_SCHEMA,
    ORGANIZATION_SCHEMA,
    ADDRESS_SCHEMA,
    SECRET_SCHEMA,
    LOGIN_INPUT_SCHEMA,
} from "./fixtures.js";

function makeServer(opts: {
    validators?: ValidatorRegistry;
    formatters?: FormatterRegistry;
} = {}): { server: KeymaServer; adapter: InMemoryAdapter } {
    const adapter = new InMemoryAdapter();
    const server = new KeymaServer({
        schemas: [USER_SCHEMA, ORGANIZATION_SCHEMA, ADDRESS_SCHEMA],
        adapter,
        ...(opts.validators !== undefined ? { validators: opts.validators } : {}),
        ...(opts.formatters !== undefined ? { formatters: opts.formatters } : {}),
    });
    return { server, adapter };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("KeymaServer — single-leaf operations", () => {
    it("create: applies save-phase formatters and validates payload", async () => {
        const formatters: FormatterRegistry = new Map([
            ["normalizeEmail", (v) => typeof v === "string" ? v.toLowerCase().trim() : v],
        ]);
        const { server, adapter } = makeServer({ formatters });
        const req: KeymaRequest = {
            operations: {
                a: {
                    op: "create",
                    schema: "user",
                    data: { email: "  USER@EXAMPLE.COM  ", name: "Alice" },
                },
            },
        };
        const resp = await server.handle(req);
        const a = resp.results["a"] as KeymaLeafSuccess<Record<string, unknown>>;
        assert.equal(a.ok, true);
        assert.equal(a.data["email"], "user@example.com");
        const stored = [...adapter.stores.get("user")!.values()][0];
        assert.equal(stored?.["email"], "user@example.com");
    });

    it("create: returns VALIDATION_FAILED with errors when invalid", async () => {
        const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
        const validators: ValidatorRegistry = new Map([
            ["emailAddress", (v, _spec, field) =>
                typeof v === "string" && !EMAIL_RE.test(v)
                    ? { field, code: "emailAddress", message: `${field} must be a valid email address` }
                    : null],
            ["minLength", (v, spec, field) => {
                const min = typeof spec["value"] === "number" ? spec["value"] : 0;
                return typeof v === "string" && v.length < min
                    ? { field, code: "minLength", message: `${field} must be at least ${min} characters` }
                    : null;
            }],
        ]);
        const { server } = makeServer({ validators });
        const resp = await server.handle({
            operations: {
                a: { op: "create", schema: "user", data: { email: "not-email", name: "X" } },
            },
        });
        const a = resp.results["a"] as KeymaLeafFailure;
        assert.equal(a.ok, false);
        assert.equal(a.code, "VALIDATION_FAILED");
        const codes = (a.errors ?? []).map((e) => e.code).sort();
        assert.deepEqual(codes, ["emailAddress", "minLength"]);
    });

    it("create: skips validation of readonly fields like id", async () => {
        const { server } = makeServer();
        // 'id' is readonly + required; client did not supply it. Should still pass.
        const resp = await server.handle({
            operations: {
                a: { op: "create", schema: "user", data: { email: "u@x.com", name: "Alice" } },
            },
        });
        const a = resp.results["a"] as KeymaLeafSuccess<Record<string, unknown>>;
        assert.equal(a.ok, true);
    });

    it("read: returns NOT_FOUND for missing records", async () => {
        const { server } = makeServer();
        const resp = await server.handle({
            operations: {
                a: { op: "read", schema: "user", where: { id: "nope" } },
            },
        });
        const a = resp.results["a"] as KeymaLeafFailure;
        assert.equal(a.ok, false);
        assert.equal(a.code, "NOT_FOUND");
    });

    it("read: strips private fields from response by default", async () => {
        const { server, adapter } = makeServer();
        adapter.stores.set(
            "user",
            new Map([["u1", { id: "u1", email: "a@b.com", name: "Alice", secret: "shh" }]]),
        );
        const resp = await server.handle({
            operations: {
                a: { op: "read", schema: "user", where: { id: "u1" } },
            },
        });
        const a = resp.results["a"] as KeymaLeafSuccess<Record<string, unknown>>;
        assert.equal(a.ok, true);
        assert.equal("secret" in a.data, false);
    });

    it("list: applies skip and limit from options", async () => {
        const { server, adapter } = makeServer();
        const store = new Map<string, Record<string, unknown>>();
        for (let i = 1; i <= 5; i++) {
            store.set(`u${i}`, { id: `u${i}`, email: `u${i}@x.com`, name: `User${i}` });
        }
        adapter.stores.set("user", store);
        const resp = await server.handle({
            operations: {
                a: { op: "list", schema: "user", options: { skip: 1, limit: 2 } },
            },
        });
        const a = resp.results["a"] as KeymaLeafSuccess<Array<Record<string, unknown>>>;
        assert.equal(a.data.length, 2);
        assert.equal(a.data[0]?.["id"], "u2");
    });

    it("update: applies save-phase formatters", async () => {
        const formatters: FormatterRegistry = new Map([
            ["normalizeEmail", (v) => typeof v === "string" ? v.toLowerCase().trim() : v],
        ]);
        const { server, adapter } = makeServer({ formatters });
        adapter.stores.set(
            "user",
            new Map([["u1", { id: "u1", email: "old@x.com", name: "Alice" }]]),
        );
        await server.handle({
            operations: {
                a: {
                    op: "update",
                    schema: "user",
                    where: { id: "u1" },
                    data: { email: "  NEW@X.COM  " },
                },
            },
        });
        assert.equal(adapter.stores.get("user")?.get("u1")?.["email"], "new@x.com");
    });

    it("delete: removes the record", async () => {
        const { server, adapter } = makeServer();
        adapter.stores.set(
            "user",
            new Map([["u1", { id: "u1", email: "a@b.com", name: "Alice" }]]),
        );
        const resp = await server.handle({
            operations: {
                a: { op: "delete", schema: "user", where: { id: "u1" } },
            },
        });
        const a = resp.results["a"] as KeymaLeafSuccess<null>;
        assert.equal(a.ok, true);
        assert.equal(adapter.stores.get("user")?.has("u1"), false);
    });

    it("unknown schema: SCHEMA_NOT_FOUND", async () => {
        const { server } = makeServer();
        const resp = await server.handle({
            operations: {
                a: { op: "read", schema: "ghost", where: { id: "x" } },
            },
        });
        const a = resp.results["a"] as KeymaLeafFailure;
        assert.equal(a.code, "SCHEMA_NOT_FOUND");
    });
});

describe("KeymaServer — private schema visibility", () => {
    function makeServerWithSecret(): { server: KeymaServer; adapter: InMemoryAdapter } {
        const adapter = new InMemoryAdapter();
        const server = new KeymaServer({
            schemas: [USER_SCHEMA, ORGANIZATION_SCHEMA, ADDRESS_SCHEMA, SECRET_SCHEMA],
            adapter,
        });
        return { server, adapter };
    }

    it("rejects ops targeting a private schema with SCHEMA_NOT_FOUND (no existence leak)", async () => {
        const { server, adapter } = makeServerWithSecret();
        adapter.stores.set("secret", new Map([["s1", { id: "s1", value: "shh" }]]));
        const resp = await server.handle({
            operations: {
                a: { op: "read", schema: "secret", where: { id: "s1" } },
                b: { op: "list", schema: "secret" },
            },
        });
        const a = resp.results["a"] as KeymaLeafFailure;
        const b = resp.results["b"] as KeymaLeafFailure;
        assert.equal(a.code, "SCHEMA_NOT_FOUND");
        assert.equal(b.code, "SCHEMA_NOT_FOUND");
    });

    it("returns the same code for private schemas as for nonexistent ones", async () => {
        // The attacker-supplied name is echoed in the error message, which is fine —
        // they already know what they asked for. What matters is that the *code* is
        // indistinguishable, so a probe can't tell `private` from `nonexistent`.
        const { server } = makeServerWithSecret();
        const resp = await server.handle({
            operations: {
                priv: { op: "read", schema: "secret", where: { id: "x" } },
                ghost: { op: "read", schema: "ghost", where: { id: "x" } },
            },
        });
        const priv = resp.results["priv"] as KeymaLeafFailure;
        const ghost = resp.results["ghost"] as KeymaLeafFailure;
        assert.equal(priv.code, ghost.code);
        assert.equal(priv.source, ghost.source);
    });

    it("system identity bypasses the visibility guard", async () => {
        const { server, adapter } = makeServerWithSecret();
        adapter.stores.set("secret", new Map([["s1", { id: "s1", value: "shh" }]]));
        const resp = await server.handle(
            {
                operations: {
                    a: { op: "read", schema: "secret", where: { id: "s1" } },
                },
            },
            { identity: { isSystem: true } },
        );
        const a = resp.results["a"] as KeymaLeafSuccess<Record<string, unknown>>;
        assert.equal(a.ok, true);
        assert.equal(a.data["value"], "shh");
    });
});

describe("KeymaServer — ephemeral schemas", () => {
    function makeServerWithEphemeral(): { server: KeymaServer; adapter: InMemoryAdapter } {
        const adapter = new InMemoryAdapter();
        const server = new KeymaServer({
            schemas: [USER_SCHEMA, LOGIN_INPUT_SCHEMA],
            adapter,
        });
        return { server, adapter };
    }

    it("ensureSchemas does not provision a store for an ephemeral schema", async () => {
        const { server, adapter } = makeServerWithEphemeral();
        await server.ensureSchemas();
        assert.equal(adapter.stores.has("loginInput"), false);
        assert.equal(adapter.stores.has("user"), true);
    });

    it("rejects CRUD ops targeting an ephemeral schema with NOT_PERSISTED", async () => {
        const { server } = makeServerWithEphemeral();
        const resp = await server.handle({
            operations: {
                a: { op: "create", schema: "loginInput", data: { email: "a@b.com", password: "x" } },
                b: { op: "list", schema: "loginInput" },
            },
        });
        const a = resp.results["a"] as KeymaLeafFailure;
        const b = resp.results["b"] as KeymaLeafFailure;
        assert.equal(a.ok, false);
        assert.equal(a.code, "NOT_PERSISTED");
        assert.equal(b.code, "NOT_PERSISTED");
    });
});

describe("KeymaServer — batch isolation", () => {
    it("a failing leaf does not poison the others", async () => {
        const { server, adapter } = makeServer();
        adapter.stores.set(
            "user",
            new Map([["u1", { id: "u1", email: "a@b.com", name: "Alice" }]]),
        );
        const resp = await server.handle({
            operations: {
                hit: { op: "read", schema: "user", where: { id: "u1" } },
                miss: { op: "read", schema: "user", where: { id: "nope" } },
            },
        });
        const hit = resp.results["hit"] as KeymaLeafSuccess<unknown>;
        const miss = resp.results["miss"] as KeymaLeafFailure;
        assert.equal(hit.ok, true);
        assert.equal(miss.ok, false);
        assert.equal(miss.code, "NOT_FOUND");
    });
});

describe("KeymaServer — projection", () => {
    it("Reference<T>: 1 leaves the id; nested object resolves via adapter populate", async () => {
        const { server, adapter } = makeServer();
        adapter.stores.set(
            "organization",
            new Map([["o1", { id: "o1", name: "Acme", tier: "pro" }]]),
        );
        adapter.stores.set(
            "user",
            new Map([["u1", { id: "u1", email: "a@b.com", name: "Alice", organization: "o1" }]]),
        );

        // sub === 1: id passes through unchanged
        const r1 = await server.handle({
            operations: {
                a: {
                    op: "read",
                    schema: "user",
                    where: { id: "u1" },
                    project: { organization: 1 },
                },
            },
        });
        const a1 = r1.results["a"] as KeymaLeafSuccess<Record<string, unknown>>;
        assert.equal(a1.data["organization"], "o1");

        // nested projection: resolved + projected
        const r2 = await server.handle({
            operations: {
                a: {
                    op: "read",
                    schema: "user",
                    where: { id: "u1" },
                    project: { organization: { name: 1 } },
                },
            },
        });
        const a2 = r2.results["a"] as KeymaLeafSuccess<Record<string, unknown>>;
        assert.deepEqual(a2.data["organization"], { name: "Acme" });
    });

    it("Embedded<T>: picks listed fields from inline data", async () => {
        const { server, adapter } = makeServer();
        adapter.stores.set(
            "user",
            new Map([
                [
                    "u1",
                    {
                        id: "u1",
                        email: "a@b.com",
                        name: "Alice",
                        address: { line1: "123 Main", city: "Springfield", postalCode: "12345" },
                    },
                ],
            ]),
        );
        const resp = await server.handle({
            operations: {
                a: {
                    op: "read",
                    schema: "user",
                    where: { id: "u1" },
                    project: { address: { city: 1 } },
                },
            },
        });
        const a = resp.results["a"] as KeymaLeafSuccess<Record<string, unknown>>;
        assert.deepEqual(a.data["address"], { city: "Springfield" });
    });

    it("missing referenced record becomes null", async () => {
        const { server, adapter } = makeServer();
        adapter.stores.set("organization", new Map());
        adapter.stores.set(
            "user",
            new Map([["u1", { id: "u1", email: "a@b.com", name: "Alice", organization: "missing" }]]),
        );
        const resp = await server.handle({
            operations: {
                a: {
                    op: "read",
                    schema: "user",
                    where: { id: "u1" },
                    project: { organization: { name: 1 } },
                },
            },
        });
        const a = resp.results["a"] as KeymaLeafSuccess<Record<string, unknown>>;
        assert.equal(a.data["organization"], null);
    });
});

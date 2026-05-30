import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KeymaServer } from "../src/server.js";
import type {
    KeymaDatabaseAdapter,
    ListQuery,
    AdapterProjection,
    AdapterFieldSpec,
} from "../src/adapter.js";
import type { KeymaRequest, KeymaLeafFailure, KeymaLeafSuccess } from "../src/protocol.js";
import type { SchemaMetadata } from "../src/types.js";
import {
    USER_SCHEMA,
    ORGANIZATION_SCHEMA,
    ADDRESS_SCHEMA,
    SECRET_SCHEMA,
} from "./fixtures.js";

// ─── In-memory adapter ───────────────────────────────────────────────────────

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
        const id = (data["id"] as string | undefined) ?? `${schema.name}-${++this.counter}`;
        const record = { ...data, id };
        store.set(id, record);
        return projection !== undefined ? this.applyProjection(record, projection) : record;
    }

    async read(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown> | null> {
        const store = this.storeFor(schema);
        const id = where["id"] as string;
        const record = store.get(id) ?? null;
        if (record === null || projection === undefined) return record;
        return this.applyProjection(record, projection);
    }

    async list(
        schema: SchemaMetadata,
        query: ListQuery,
    ): Promise<Record<string, unknown>[]> {
        let results = [...this.storeFor(schema).values()];
        if (query.skip !== undefined) results = results.slice(query.skip);
        if (query.limit !== undefined) results = results.slice(0, query.limit);
        if (query.projection !== undefined) {
            const proj = query.projection;
            results = results.map((r) => this.applyProjection(r, proj));
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
        const id = where["id"] as string;
        const existing = store.get(id) ?? {};
        const updated = { ...existing, ...data, id };
        store.set(id, updated);
        return projection !== undefined ? this.applyProjection(updated, projection) : updated;
    }

    async delete(schema: SchemaMetadata, where: Record<string, unknown>): Promise<void> {
        const store = this.storeFor(schema);
        const id = where["id"] as string;
        store.delete(id);
    }

    private applyProjection(
        record: Record<string, unknown>,
        projection: AdapterProjection,
    ): Record<string, unknown> {
        const result: Record<string, unknown> = {};
        for (const [key, spec] of Object.entries(projection.fields ?? {})) {
            if (spec === 1) {
                result[key] = record[key];
            } else {
                const value = record[key];
                result[key] =
                    typeof value === "object" && value !== null
                        ? this.applyEmbeddedSpec(value as Record<string, unknown>, spec)
                        : null;
            }
        }
        for (const [field, node] of Object.entries(projection.populate ?? {})) {
            const value = record[field];
            if (typeof value !== "string") {
                result[field] = null;
                continue;
            }
            const referenced = this.storeFor(node.schema).get(value) ?? null;
            if (referenced === null) {
                result[field] = null;
            } else if (node.projection !== undefined) {
                result[field] = this.applyProjection(referenced, node.projection);
            } else {
                result[field] = referenced;
            }
        }
        return result;
    }

    private applyEmbeddedSpec(
        value: Record<string, unknown>,
        spec: { [key: string]: AdapterFieldSpec },
    ): Record<string, unknown> {
        const result: Record<string, unknown> = {};
        for (const [key, sub] of Object.entries(spec)) {
            if (sub === 1) {
                result[key] = value[key];
            } else {
                const nested = value[key];
                result[key] =
                    typeof nested === "object" && nested !== null
                        ? this.applyEmbeddedSpec(nested as Record<string, unknown>, sub)
                        : null;
            }
        }
        return result;
    }
}

function makeServer(): { server: KeymaServer; adapter: InMemoryAdapter } {
    const adapter = new InMemoryAdapter();
    const server = new KeymaServer({
        schemas: [USER_SCHEMA, ORGANIZATION_SCHEMA, ADDRESS_SCHEMA],
        adapter,
    });
    return { server, adapter };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("KeymaServer — single-leaf operations", () => {
    it("create: applies save-phase formatters and validates payload", async () => {
        const { server, adapter } = makeServer();
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
        const { server } = makeServer();
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
        const { server, adapter } = makeServer();
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

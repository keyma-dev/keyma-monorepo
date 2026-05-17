import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keyma } from "../src/query.js";
import { KeymaServer } from "../src/server.js";
import { createDirectTransport } from "../src/client.js";
import type {
    KeymaDatabaseAdapter,
    ListQuery,
    AdapterProjection,
    AdapterFieldSpec,
} from "../src/adapter.js";
import type { SchemaMetadata } from "../src/types.js";
import {
    User,
    Organization,
    USER_SCHEMA,
    ORGANIZATION_SCHEMA,
    ADDRESS_SCHEMA,
} from "./fixtures.js";

class InMemoryAdapter implements KeymaDatabaseAdapter {
    public stores = new Map<string, Map<string, Record<string, unknown>>>();
    private counter = 0;

    private storeFor(s: SchemaMetadata): Map<string, Record<string, unknown>> {
        let st = this.stores.get(s.name);
        if (st === undefined) {
            st = new Map();
            this.stores.set(s.name, st);
        }
        return st;
    }

    async ensureSchema(s: SchemaMetadata): Promise<void> {
        this.storeFor(s);
    }

    async create(
        s: SchemaMetadata,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>> {
        const store = this.storeFor(s);
        const id = (data["id"] as string | undefined) ?? `${s.name}-${++this.counter}`;
        const record = { ...data, id };
        store.set(id, record);
        return projection !== undefined ? this.applyProjection(record, projection) : record;
    }

    async read(
        s: SchemaMetadata,
        where: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown> | null> {
        const record = this.storeFor(s).get(where["id"] as string) ?? null;
        if (record === null || projection === undefined) return record;
        return this.applyProjection(record, projection);
    }

    async list(s: SchemaMetadata, q: ListQuery): Promise<Record<string, unknown>[]> {
        let r = [...this.storeFor(s).values()];
        if (q.skip !== undefined) r = r.slice(q.skip);
        if (q.limit !== undefined) r = r.slice(0, q.limit);
        if (q.projection !== undefined) {
            const proj = q.projection;
            r = r.map((record) => this.applyProjection(record, proj));
        }
        return r;
    }

    async update(
        s: SchemaMetadata,
        where: Record<string, unknown>,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>> {
        const store = this.storeFor(s);
        const id = where["id"] as string;
        const existing = store.get(id) ?? {};
        const updated = { ...existing, ...data, id };
        store.set(id, updated);
        return projection !== undefined ? this.applyProjection(updated, projection) : updated;
    }

    async delete(s: SchemaMetadata, where: Record<string, unknown>): Promise<void> {
        this.storeFor(s).delete(where["id"] as string);
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

function setupServer() {
    const adapter = new InMemoryAdapter();
    const server = new KeymaServer({
        schemas: [USER_SCHEMA, ORGANIZATION_SCHEMA, ADDRESS_SCHEMA],
        adapter,
    });
    return { server, adapter, transport: createDirectTransport(server) };
}

describe("template + server end-to-end", () => {
    it("README example: query with list + read, reference projection", async () => {
        const { adapter, transport } = setupServer();
        adapter.stores.set(
            "organization",
            new Map([["o1", { id: "o1", name: "Acme", tier: "pro" }]]),
        );
        adapter.stores.set(
            "user",
            new Map([
                ["u1", { id: "u1", email: "alice@gmail.com", name: "Alice", organization: "o1" }],
                ["u2", { id: "u2", email: "bob@gmail.com", name: "Bob", organization: "o1" }],
            ]),
        );

        const q = Keyma.query({
            users: Keyma.list(User, undefined, { organization: { name: 1 } }),
            user: Keyma.read(User, { id: Keyma.input("id") }, { organization: { name: 1 } }),
        });

        const response = await q.request(
            { users: { skip: 0, limit: 10 } },
            { inputs: { user: { id: "u1" } }, transport },
        );

        assert.equal(response.results.users.ok, true);
        if (response.results.users.ok) {
            assert.equal(response.results.users.data.length, 2);
            assert.deepEqual(
                response.results.users.data[0]?.organization,
                { name: "Acme" },
            );
        }
        assert.equal(response.results.user.ok, true);
        if (response.results.user.ok && response.results.user.data !== null) {
            assert.deepEqual(response.results.user.data.organization, { name: "Acme" });
        }
    });

    it("template is reusable across multiple .request() calls", async () => {
        const { adapter, transport } = setupServer();
        adapter.stores.set(
            "user",
            new Map([
                ["u1", { id: "u1", email: "a@x.com", name: "Alice" }],
                ["u2", { id: "u2", email: "b@x.com", name: "Bob" }],
            ]),
        );

        const q = Keyma.query({
            user: Keyma.read(User, { id: Keyma.input("id") }),
        });

        const r1 = await q.request({}, { inputs: { user: { id: "u1" } }, transport });
        const r2 = await q.request({}, { inputs: { user: { id: "u2" } }, transport });

        assert.equal(r1.results.user.ok, true);
        assert.equal(r2.results.user.ok, true);
        if (r1.results.user.ok && r1.results.user.data !== null) {
            assert.equal(r1.results.user.data.email, "a@x.com");
        }
        if (r2.results.user.ok && r2.results.user.data !== null) {
            assert.equal(r2.results.user.data.email, "b@x.com");
        }
    });

    it("mutation: create + delete are independent (per-leaf results)", async () => {
        const { transport } = setupServer();

        const m = Keyma.mutation({
            ok: Keyma.create(Organization, {
                name: Keyma.input("name"),
                tier: Keyma.input("tier"),
            }),
            bad: Keyma.create(User, {
                email: Keyma.input("email"),
                name: Keyma.input("name"),
            }),
        });

        const response = await m.request(
            {},
            {
                inputs: {
                    ok: { name: "Acme", tier: "pro" },
                    bad: { email: "not-an-email", name: "X" },
                },
                transport,
            },
        );

        assert.equal(response.results.ok.ok, true);
        assert.equal(response.results.bad.ok, false);
        if (!response.results.bad.ok) {
            assert.equal(response.results.bad.code, "VALIDATION_FAILED");
        }
    });

    it("hydrates response data into schema class instances", async () => {
        const { adapter, transport } = setupServer();
        adapter.stores.set(
            "user",
            new Map([
                ["u1", { id: "u1", email: "a@x.com", name: "Alice" }],
                ["u2", { id: "u2", email: "b@x.com", name: "Bob" }],
            ]),
        );
        adapter.stores.set(
            "organization",
            new Map([["o1", { id: "o1", name: "Acme", tier: "pro" }]]),
        );

        const q = Keyma.query({
            user: Keyma.read(User, { id: Keyma.input("id") }),
            users: Keyma.list(User),
            org: Keyma.read(Organization, { id: Keyma.input("oid") }),
        });

        const resp = await q.request(
            {},
            { inputs: { user: { id: "u1" }, org: { oid: "o1" } }, transport },
        );

        assert.equal(resp.results.user.ok, true);
        if (resp.results.user.ok && resp.results.user.data !== null) {
            assert.ok(resp.results.user.data instanceof User, "read result should be instanceof User");
            assert.equal(resp.results.user.data.email, "a@x.com");
        }

        assert.equal(resp.results.users.ok, true);
        if (resp.results.users.ok) {
            assert.equal(resp.results.users.data.length, 2);
            for (const u of resp.results.users.data) {
                assert.ok(u instanceof User, "list items should be instanceof User");
            }
        }

        assert.equal(resp.results.org.ok, true);
        if (resp.results.org.ok && resp.results.org.data !== null) {
            assert.ok(resp.results.org.data instanceof Organization);
            assert.equal(resp.results.org.data.name, "Acme");
        }
    });

    it("create/update return hydrated instances; delete returns null", async () => {
        const { transport, adapter } = setupServer();
        adapter.stores.set(
            "organization",
            new Map([["o1", { id: "o1", name: "Acme", tier: "free" }]]),
        );

        const m = Keyma.mutation({
            made: Keyma.create(Organization, {
                name: Keyma.input("name"),
                tier: Keyma.input("tier"),
            }),
            changed: Keyma.update(
                Organization,
                { id: Keyma.input("id") },
                { tier: Keyma.input("tier") },
            ),
            gone: Keyma.delete(Organization, { id: Keyma.input("id") }),
        });

        const resp = await m.request(
            {},
            {
                inputs: {
                    made: { name: "New Co", tier: "pro" },
                    changed: { id: "o1", tier: "enterprise" },
                    gone: { id: "o1" },
                },
                transport,
            },
        );

        if (resp.results.made.ok) {
            assert.ok(resp.results.made.data instanceof Organization);
            assert.equal(resp.results.made.data.name, "New Co");
        }
        if (resp.results.changed.ok) {
            assert.ok(resp.results.changed.data instanceof Organization);
            assert.equal(resp.results.changed.data.tier, "enterprise");
        }
        if (resp.results.gone.ok) {
            assert.equal(resp.results.gone.data, null);
        }
    });

    it("template can be used with two different transports", async () => {
        const a = setupServer();
        const b = setupServer();
        a.adapter.stores.set("user", new Map([["u1", { id: "u1", email: "a@x.com", name: "Alice" }]]));
        b.adapter.stores.set("user", new Map([["u1", { id: "u1", email: "b@x.com", name: "Bob" }]]));

        const q = Keyma.query({
            user: Keyma.read(User, { id: Keyma.input("id") }),
        });

        const ra = await q.request({}, { inputs: { user: { id: "u1" } }, transport: a.transport });
        const rb = await q.request({}, { inputs: { user: { id: "u1" } }, transport: b.transport });

        if (ra.results.user.ok && ra.results.user.data !== null) {
            assert.equal(ra.results.user.data.email, "a@x.com");
        }
        if (rb.results.user.ok && rb.results.user.data !== null) {
            assert.equal(rb.results.user.data.email, "b@x.com");
        }
    });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keyma, Input } from "../src/query.js";
import { KeymaServer } from "../src/server.js";
import { createDirectTransport } from "../src/client.js";
import type {
    KeymaDatabaseAdapter,
    ListQuery,
    AdapterProjection,
} from "../src/adapter.js";
import type { SchemaMetadata } from "../src/types.js";
import type { KeymaServerPlugin, RequestContext } from "../src/plugin.js";
import { User, USER_SCHEMA } from "./fixtures.js";

// ── Adapters ─────────────────────────────────────────────────────────────────

class InMemoryAdapter implements KeymaDatabaseAdapter {

    countCalls = 0;
    public stores = new Map<string, Map<string, Record<string, unknown>>>();

    storeFor(s: SchemaMetadata): Map<string, Record<string, unknown>> {
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
    async create(s: SchemaMetadata, data: Record<string, unknown>): Promise<Record<string, unknown>> {
        const id = (data["id"] as string | undefined) ?? `${s.name}-${this.storeFor(s).size + 1}`;
        const record = { ...data, id };
        this.storeFor(s).set(id, record);
        return record;
    }
    async read(s: SchemaMetadata, where: Record<string, unknown>): Promise<Record<string, unknown> | null> {
        return this.storeFor(s).get(where["id"] as string) ?? null;
    }
    async list(s: SchemaMetadata, q: ListQuery): Promise<Record<string, unknown>[]> {
        let r = [...this.storeFor(s).values()];
        if (q.skip !== undefined) r = r.slice(q.skip);
        if (q.limit !== undefined) r = r.slice(0, q.limit);
        return r;
    }
    async update(s: SchemaMetadata, where: Record<string, unknown>, data: Record<string, unknown>): Promise<Record<string, unknown>> {
        const id = where["id"] as string;
        const rec = { ...(this.storeFor(s).get(id) ?? {}), ...data, id };
        this.storeFor(s).set(id, rec);
        return rec;
    }
    async delete(s: SchemaMetadata, where: Record<string, unknown>): Promise<void> {
        this.storeFor(s).delete(where["id"] as string);
    }

    async count(s: SchemaMetadata, where?: Record<string, unknown>): Promise<number> {
        this.countCalls++;
        const records = [...this.storeFor(s).values()];
        if (where === undefined || Object.keys(where).length === 0) return records.length;
        return records.filter((r) =>
            Object.entries(where).every(([k, v]) => r[k] === v),
        ).length;
    }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function populate(adapter: InMemoryAdapter): void {
    adapter.stores.set(
        "user",
        new Map([
            ["u1", { id: "u1", email: "alice1@example.com", name: "Alice" }],
            ["u2", { id: "u2", email: "alice2@example.com", name: "Alice" }],
            ["u3", { id: "u3", email: "carol@example.com", name: "Carol" }],
        ]),
    );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Keyma.count", () => {
    it("total count via direct server call", async () => {
        const adapter = new InMemoryAdapter();
        populate(adapter);
        const server = new KeymaServer({ schemas: [USER_SCHEMA], adapter });
        const res = await server.handle({
            operations: { n: { op: "count", schema: "user" } },
        });
        assert.equal(res.results["n"]?.ok, true);
        assert.equal((res.results["n"] as { ok: true; data: unknown }).data, 3);
    });

    it("filtered count via native adapter.count", async () => {
        const adapter = new InMemoryAdapter();
        populate(adapter);
        const server = new KeymaServer({ schemas: [USER_SCHEMA], adapter });
        const res = await server.handle({
            operations: { n: { op: "count", schema: "user", where: { name: "Alice" } } },
        });
        assert.equal(res.results["n"]?.ok, true);
        assert.equal((res.results["n"] as { ok: true; data: unknown }).data, 2);
        assert.equal(adapter.countCalls, 1);
    });

    it("fallback to list().length when adapter has no count method", async () => {
        const adapter = new InMemoryAdapter();
        populate(adapter);
        const server = new KeymaServer({ schemas: [USER_SCHEMA], adapter });
        const res = await server.handle({
            operations: { n: { op: "count", schema: "user" } },
        });
        assert.equal(res.results["n"]?.ok, true);
        assert.equal((res.results["n"] as { ok: true; data: unknown }).data, 3);
    });

    it("Input placeholder in where clause substituted correctly", async () => {
        const adapter = new InMemoryAdapter();
        populate(adapter);
        const transport = createDirectTransport(new KeymaServer({ schemas: [USER_SCHEMA], adapter }));

        const q = Keyma.query({
            n: Keyma.count(User, { name: new Input("name") }),
        });

        const { results } = await q.request(
            {},
            { inputs: { n: { name: "Alice" } }, transport },
        );

        assert.equal(results.n.ok, true);
        if (results.n.ok) {
            const n: number = results.n.data;
            assert.equal(n, 2);
        }
    });

    it("end-to-end via Keyma.query with createDirectTransport; data typed as number", async () => {
        const adapter = new InMemoryAdapter();
        populate(adapter);
        const transport = createDirectTransport(new KeymaServer({ schemas: [USER_SCHEMA], adapter }));

        const q = Keyma.query({ n: Keyma.count(User) });
        const { results } = await q.request({}, { inputs: {}, transport });

        assert.equal(results.n.ok, true);
        if (results.n.ok) {
            const n: number = results.n.data;
            assert.equal(n, 3);
        }
    });

    it("transformFilter plugin hook fires with action 'count' and augmented filter applies", async () => {
        const adapter = new InMemoryAdapter();
        populate(adapter);

        const filterActions: string[] = [];
        const aclPlugin: KeymaServerPlugin = {
            name: "acl",
            transformFilter(_ctx: RequestContext, _schema: SchemaMetadata, where: Record<string, unknown>, action: string) {
                filterActions.push(action);
                // Restrict to Alice only
                return { ...where, name: "Alice" };
            },
        };

        const server = new KeymaServer({ schemas: [USER_SCHEMA], adapter, plugins: [aclPlugin] });
        const res = await server.handle({
            operations: { n: { op: "count", schema: "user" } },
        });

        assert.deepEqual(filterActions, ["count"]);
        assert.equal(res.results["n"]?.ok, true);
        assert.equal((res.results["n"] as { ok: true; data: unknown }).data, 2);
    });

    it("unknown schema returns SCHEMA_NOT_FOUND failure", async () => {
        const adapter = new InMemoryAdapter();
        const server = new KeymaServer({ schemas: [USER_SCHEMA], adapter });
        const res = await server.handle({
            operations: { n: { op: "count", schema: "nonexistent" } },
        });
        assert.equal(res.results["n"]?.ok, false);
        assert.equal((res.results["n"] as { ok: false; code: string }).code, "SCHEMA_NOT_FOUND");
    });
});

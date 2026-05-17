import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KeymaServer } from "../src/server.js";
import { KeymaDenied, KeymaFieldForbidden, type KeymaServerPlugin } from "../src/plugin.js";
import type {
    KeymaDatabaseAdapter,
    ListQuery,
    AdapterProjection,
    AdapterFieldSpec,
} from "../src/adapter.js";
import type {
    KeymaRequest,
    KeymaLeafFailure,
    KeymaLeafSuccess,
} from "../src/protocol.js";
import type { SchemaMetadata } from "../src/types.js";
import { USER_SCHEMA, ORGANIZATION_SCHEMA, ADDRESS_SCHEMA } from "./fixtures.js";

// ── Recording in-memory adapter ──────────────────────────────────────────────

type AdapterCall =
    | { kind: "list"; schema: string; query: ListQuery }
    | { kind: "read"; schema: string; where: Record<string, unknown> }
    | { kind: "create"; schema: string; data: Record<string, unknown> }
    | { kind: "update"; schema: string; where: Record<string, unknown>; data: Record<string, unknown> }
    | { kind: "delete"; schema: string; where: Record<string, unknown> };

class RecordingAdapter implements KeymaDatabaseAdapter {
    public stores = new Map<string, Map<string, Record<string, unknown>>>();
    public calls: AdapterCall[] = [];
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
        this.calls.push({ kind: "create", schema: schema.name, data });
        const store = this.storeFor(schema);
        const id = (data["id"] as string | undefined) ?? `${schema.name}-${++this.counter}`;
        const record = { ...data, id };
        store.set(id, record);
        return projection !== undefined ? applyProjection(record, projection) : record;
    }

    async read(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown> | null> {
        this.calls.push({ kind: "read", schema: schema.name, where });
        const store = this.storeFor(schema);
        const id = where["id"] as string;
        const record = store.get(id) ?? null;
        if (record === null || projection === undefined) return record;
        return applyProjection(record, projection);
    }

    async list(
        schema: SchemaMetadata,
        query: ListQuery,
    ): Promise<Record<string, unknown>[]> {
        this.calls.push({ kind: "list", schema: schema.name, query });
        let results = [...this.storeFor(schema).values()];
        // Honor a minimal $eq predicate (the only one the tests need).
        for (const [field, spec] of Object.entries(query.where)) {
            if (
                typeof spec === "object" &&
                spec !== null &&
                "$eq" in (spec as Record<string, unknown>)
            ) {
                const expect = (spec as { $eq: unknown }).$eq;
                results = results.filter((r) => r[field] === expect);
            } else {
                results = results.filter((r) => r[field] === spec);
            }
        }
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
        this.calls.push({ kind: "update", schema: schema.name, where, data });
        const store = this.storeFor(schema);
        const id = where["id"] as string;
        const existing = store.get(id) ?? {};
        const updated = { ...existing, ...data, id };
        store.set(id, updated);
        return projection !== undefined ? applyProjection(updated, projection) : updated;
    }

    async delete(schema: SchemaMetadata, where: Record<string, unknown>): Promise<void> {
        this.calls.push({ kind: "delete", schema: schema.name, where });
        const store = this.storeFor(schema);
        const id = where["id"] as string;
        store.delete(id);
    }
}

function applyProjection(
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
        if (sub === 1) {
            result[key] = value[key];
        } else {
            const nested = value[key];
            result[key] =
                typeof nested === "object" && nested !== null
                    ? applyEmbeddedSpec(nested as Record<string, unknown>, sub)
                    : null;
        }
    }
    return result;
}

function makeServer(plugins: KeymaServerPlugin[]): {
    server: KeymaServer;
    adapter: RecordingAdapter;
} {
    const adapter = new RecordingAdapter();
    const server = new KeymaServer({
        schemas: [USER_SCHEMA, ORGANIZATION_SCHEMA, ADDRESS_SCHEMA],
        adapter,
        plugins,
    });
    return { server, adapter };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("KeymaServer — plugin surface", () => {
    it("transformFilter: rewritten where reaches the adapter", async () => {
        const plugin: KeymaServerPlugin = {
            name: "scope",
            transformFilter(_ctx, _schema, where) {
                return { $and: [where, { tenant: { $eq: "t1" } }] };
            },
        };
        const { server, adapter } = makeServer([plugin]);
        const req: KeymaRequest = {
            operations: {
                a: { op: "list", schema: "user", where: { active: true } },
            },
        };
        await server.handle(req);
        const call = adapter.calls.find((c) => c.kind === "list");
        assert.ok(call?.kind === "list");
        assert.deepEqual(call.query.where, {
            $and: [{ active: true }, { tenant: { $eq: "t1" } }],
        });
    });

    it("transformFilter: plugins fold in registration order", async () => {
        const log: string[] = [];
        const p1: KeymaServerPlugin = {
            name: "p1",
            transformFilter(_ctx, _schema, where) {
                log.push(`p1 saw ${JSON.stringify(where)}`);
                return { ...where, p1: 1 };
            },
        };
        const p2: KeymaServerPlugin = {
            name: "p2",
            transformFilter(_ctx, _schema, where) {
                log.push(`p2 saw ${JSON.stringify(where)}`);
                return { ...where, p2: 1 };
            },
        };
        const { server, adapter } = makeServer([p1, p2]);
        await server.handle({
            operations: { a: { op: "list", schema: "user", where: { x: 0 } } },
        });
        const call = adapter.calls.find((c) => c.kind === "list");
        assert.ok(call?.kind === "list");
        assert.deepEqual(call.query.where, { x: 0, p1: 1, p2: 1 });
        assert.equal(log[0], `p1 saw {"x":0}`);
        assert.equal(log[1], `p2 saw {"x":0,"p1":1}`);
    });

    it("KeymaDenied from beforeOperation becomes FORBIDDEN", async () => {
        const plugin: KeymaServerPlugin = {
            name: "deny-all",
            beforeOperation() {
                throw new KeymaDenied("nope", "deny-all");
            },
        };
        const { server } = makeServer([plugin]);
        const resp = await server.handle({
            operations: { a: { op: "list", schema: "user" } },
        });
        const a = resp.results["a"] as KeymaLeafFailure;
        assert.equal(a.ok, false);
        assert.equal(a.code, "FORBIDDEN");
        assert.equal(a.plugin, "deny-all");
    });

    it("KeymaFieldForbidden from checkWrite becomes FIELD_FORBIDDEN with field list", async () => {
        const plugin: KeymaServerPlugin = {
            name: "no-secret",
            checkWrite(_ctx, _schema, data) {
                if ("secret" in data) {
                    throw new KeymaFieldForbidden(["secret"], "no-secret");
                }
            },
        };
        const { server } = makeServer([plugin]);
        const resp = await server.handle({
            operations: {
                a: {
                    op: "create",
                    schema: "user",
                    data: { email: "u@x.com", name: "Alice", secret: "shh" },
                },
            },
        });
        const a = resp.results["a"] as KeymaLeafFailure;
        assert.equal(a.code, "FIELD_FORBIDDEN");
        assert.deepEqual(a.fields, ["secret"]);
    });

    it("other plugin errors become PLUGIN_ERROR (not poisoning the batch)", async () => {
        const plugin: KeymaServerPlugin = {
            name: "boom",
            beforeOperation(_ctx, op) {
                if (op.schema === "user") throw new Error("kaboom");
            },
        };
        const { server, adapter } = makeServer([plugin]);
        adapter.stores.set(
            "organization",
            new Map([["o1", { id: "o1", name: "Acme", tier: "pro" }]]),
        );
        const resp = await server.handle({
            operations: {
                bad: { op: "list", schema: "user" },
                good: { op: "list", schema: "organization" },
            },
        });
        const bad = resp.results["bad"] as KeymaLeafFailure;
        const good = resp.results["good"] as KeymaLeafSuccess<unknown>;
        assert.equal(bad.code, "PLUGIN_ERROR");
        assert.equal(bad.error, "kaboom");
        assert.equal(good.ok, true);
    });

    it("transformProjection: trims fields before adapter call", async () => {
        const plugin: KeymaServerPlugin = {
            name: "hide-email",
            transformProjection(_ctx, _schema, proj) {
                if (proj.fields !== undefined) {
                    const { email: _omit, ...rest } = proj.fields as Record<string, unknown>;
                    return { ...proj, fields: rest as typeof proj.fields };
                }
                return proj;
            },
        };
        const { server, adapter } = makeServer([plugin]);
        adapter.stores.set(
            "user",
            new Map([["u1", { id: "u1", email: "a@b.com", name: "Alice" }]]),
        );
        const resp = await server.handle({
            operations: {
                a: { op: "read", schema: "user", where: { id: "u1" } },
            },
        });
        const a = resp.results["a"] as KeymaLeafSuccess<Record<string, unknown>>;
        assert.equal(a.ok, true);
        assert.equal("email" in a.data, false);
        assert.equal(a.data["name"], "Alice");
    });

    it("transformResult: post-processes records on the way out", async () => {
        const plugin: KeymaServerPlugin = {
            name: "strip-extras",
            transformResult(_ctx, _schema, records) {
                return records.map((r) => {
                    const { id, name } = r;
                    return { id, name };
                });
            },
        };
        const { server, adapter } = makeServer([plugin]);
        adapter.stores.set(
            "user",
            new Map([
                ["u1", { id: "u1", email: "a@b.com", name: "Alice", extra: 1 }],
                ["u2", { id: "u2", email: "b@b.com", name: "Bob", extra: 2 }],
            ]),
        );
        const resp = await server.handle({
            operations: { a: { op: "list", schema: "user" } },
        });
        const a = resp.results["a"] as KeymaLeafSuccess<Array<Record<string, unknown>>>;
        assert.deepEqual(a.data, [
            { id: "u1", name: "Alice" },
            { id: "u2", name: "Bob" },
        ]);
    });

    it("checkWrite: returned data replaces the payload sent to the adapter", async () => {
        const plugin: KeymaServerPlugin = {
            name: "force-tenant",
            checkWrite(_ctx, _schema, data) {
                return { ...data, tenant: "t1" };
            },
        };
        const { server, adapter } = makeServer([plugin]);
        await server.handle({
            operations: {
                a: {
                    op: "create",
                    schema: "user",
                    data: { email: "u@x.com", name: "Alice" },
                },
            },
        });
        const created = adapter.calls.find((c) => c.kind === "create");
        assert.ok(created?.kind === "create");
        assert.equal(created.data["tenant"], "t1");
    });

    it("context: passed through handle() to plugins", async () => {
        let seen: string | undefined;
        const plugin: KeymaServerPlugin = {
            name: "see-ctx",
            beforeOperation(ctx) {
                seen = ctx.identity?.id;
            },
        };
        const { server, adapter } = makeServer([plugin]);
        adapter.stores.set(
            "user",
            new Map([["u1", { id: "u1", email: "a@b.com", name: "Alice" }]]),
        );
        await server.handle(
            { operations: { a: { op: "read", schema: "user", where: { id: "u1" } } } },
            { identity: { id: "alice" } },
        );
        assert.equal(seen, "alice");
    });

    it("init: called once, sees all schemas", async () => {
        let initCount = 0;
        let seenSchemas: string[] = [];
        const plugin: KeymaServerPlugin = {
            name: "init-check",
            init(server) {
                initCount++;
                seenSchemas = server.schemas.map((s) => s.name);
            },
        };
        const { server, adapter } = makeServer([plugin]);
        adapter.stores.set("user", new Map());
        await server.handle({ operations: { a: { op: "list", schema: "user" } } });
        await server.handle({ operations: { b: { op: "list", schema: "user" } } });
        assert.equal(initCount, 1);
        assert.ok(seenSchemas.includes("user"));
        assert.ok(seenSchemas.includes("organization"));
    });

    it("afterOperation: errors thrown there do not poison the response", async () => {
        const plugin: KeymaServerPlugin = {
            name: "noisy-logger",
            afterOperation() {
                throw new Error("logger blew up");
            },
        };
        const { server, adapter } = makeServer([plugin]);
        adapter.stores.set(
            "user",
            new Map([["u1", { id: "u1", email: "a@b.com", name: "Alice" }]]),
        );
        const resp = await server.handle({
            operations: { a: { op: "read", schema: "user", where: { id: "u1" } } },
        });
        const a = resp.results["a"] as KeymaLeafSuccess<unknown>;
        assert.equal(a.ok, true);
    });
});

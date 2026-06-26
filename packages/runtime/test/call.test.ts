import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KeymaServer } from "../src/server.js";
import { InMemoryAdapter, brandSchema, brandService } from "../src/testing.js";
import { createDirectTransport } from "../src/client.js";
import { Keyma } from "../src/query.js";
import {
    type SchemaMetadata,
    type ServiceMetadata,
    type ValidatorFn,
    type ServiceClass,
} from "../src/types.js";
import type { KeymaLeafFailure, KeymaLeafSuccess, KeymaRequest } from "../src/protocol.js";
import type { KeymaServerPlugin } from "../src/plugin.js";
import { ORGANIZATION_SCHEMA } from "./fixtures.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const required: ValidatorFn = (v, field) =>
    v === undefined || v === null || v === "" ? { field, code: "required", message: "required" } : null;

const GREET_INPUT_SCHEMA: SchemaMetadata = {
    name: "greetInput",
    sourceName: "GreetInput",
    ephemeral: true,
    fields: [{ name: "name", type: { kind: "string" }, validators: [required] }],
};

type GreetResultRecord = { message: string };
class GreetResultCtor {
    declare message: string;
    constructor(value?: Partial<GreetResultRecord>) {
        if (value) Object.assign(this, value);
    }
}
const GREET_RESULT_SCHEMA: SchemaMetadata = {
    name: "greetResult",
    sourceName: "GreetResult",
    ephemeral: true,
    fields: [{ name: "message", type: { kind: "string" } }],
};
const GreetResult = brandSchema(GreetResultCtor, GREET_RESULT_SCHEMA);

const GREET_SERVICE_META: ServiceMetadata = {
    name: "GreetService",
    methods: [
        { name: "greet", params: [{ name: "input", schema: "greetInput" }], returnSchema: "greetResult" },
        { name: "shout", params: [{ name: "text" }] },
        { name: "boom", params: [] },
        { name: "secret", visibility: "private", params: [] },
    ],
    refs: new Map([["greetResult", GreetResult]]),
};

class GreetServiceBase {}
brandService(GreetServiceBase, GREET_SERVICE_META);

class GreetServiceImpl extends GreetServiceBase {
    async greet(input: { name: string }, ctx: { identity?: { id?: string } }): Promise<GreetResultRecord> {
        const who = ctx.identity?.id ? ` (by ${ctx.identity.id})` : "";
        return { message: `Hi ${input.name}${who}` };
    }
    shout(text: string): string {
        return text.toUpperCase();
    }
    boom(): never {
        throw new Error("kaboom");
    }
    secret(): string {
        return "classified";
    }
}

const ADMIN_SERVICE_META: ServiceMetadata = {
    name: "AdminService",
    visibility: "private",
    methods: [{ name: "wipe", params: [] }],
};
class AdminServiceBase {}
brandService(AdminServiceBase, ADMIN_SERVICE_META);
class AdminServiceImpl extends AdminServiceBase {
    wipe(): string {
        return "wiped";
    }
}

// Client-side marked handle for type-safe Keyma.call(...) — mirrors the structural
// `__service` marker the JS backend emits on generated client service classes.
const GreetService = GreetServiceBase as unknown as ServiceClass & {
    readonly __service?: {
        greet: { args: { input: { name: string } }; ret: GreetResultRecord };
        shout: { args: { text: string }; ret: string };
    };
};

function makeServer(plugins: KeymaServerPlugin[] = []) {
    const adapter = new InMemoryAdapter();
    const server = new KeymaServer({
        schemas: [GREET_INPUT_SCHEMA, GREET_RESULT_SCHEMA, ORGANIZATION_SCHEMA],
        adapter,
        plugins,
        services: [new GreetServiceImpl(), () => new AdminServiceImpl()],
    });
    return { server, adapter };
}

async function call(
    server: KeymaServer,
    op: { service: string; method: string; args?: Record<string, unknown> },
    context = {},
) {
    const req: KeymaRequest = {
        operations: { a: { op: "call", service: op.service, method: op.method, args: op.args ?? {} } },
    };
    const resp = await server.handle(req, context);
    return resp.results["a"]!;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("KeymaServer — call dispatch", () => {
    it("dispatches to the registered impl and returns the value", async () => {
        const { server } = makeServer();
        const r = (await call(server, { service: "GreetService", method: "shout", args: { text: "hey" } })) as KeymaLeafSuccess<string>;
        assert.equal(r.ok, true);
        assert.equal(r.data, "HEY");
    });

    it("validates schema-typed args against their input schema", async () => {
        const { server } = makeServer();
        const r = (await call(server, { service: "GreetService", method: "greet", args: { input: { name: "" } } })) as KeymaLeafFailure;
        assert.equal(r.ok, false);
        assert.equal(r.code, "VALIDATION_FAILED");
        assert.deepEqual((r.errors ?? []).map((e) => e.code), ["required"]);
    });

    it("passes request context to the handler as the trailing argument", async () => {
        const { server } = makeServer();
        const r = (await call(
            server,
            { service: "GreetService", method: "greet", args: { input: { name: "Ann" } } },
            { identity: { id: "u1" } },
        )) as KeymaLeafSuccess<GreetResultRecord>;
        assert.equal(r.ok, true);
        assert.equal(r.data.message, "Hi Ann (by u1)");
    });

    it("unknown service → SERVICE_NOT_FOUND", async () => {
        const { server } = makeServer();
        const r = (await call(server, { service: "Nope", method: "x" })) as KeymaLeafFailure;
        assert.equal(r.code, "SERVICE_NOT_FOUND");
    });

    it("unknown method → METHOD_NOT_FOUND", async () => {
        const { server } = makeServer();
        const r = (await call(server, { service: "GreetService", method: "nope" })) as KeymaLeafFailure;
        assert.equal(r.code, "METHOD_NOT_FOUND");
    });

    it("a handler that throws becomes INTERNAL_ERROR", async () => {
        const { server } = makeServer();
        const r = (await call(server, { service: "GreetService", method: "boom" })) as KeymaLeafFailure;
        assert.equal(r.ok, false);
        assert.equal(r.code, "INTERNAL_ERROR");
        assert.equal(r.source, "runtime");
    });

    it("private methods are hidden from non-system callers", async () => {
        const { server } = makeServer();
        const denied = (await call(server, { service: "GreetService", method: "secret" })) as KeymaLeafFailure;
        assert.equal(denied.code, "METHOD_NOT_FOUND");
        const ok = (await call(server, { service: "GreetService", method: "secret" }, { identity: { isSystem: true } })) as KeymaLeafSuccess<string>;
        assert.equal(ok.data, "classified");
    });

    it("private services are hidden from non-system callers (factory provider)", async () => {
        const { server } = makeServer();
        const denied = (await call(server, { service: "AdminService", method: "wipe" })) as KeymaLeafFailure;
        assert.equal(denied.code, "SERVICE_NOT_FOUND");
        const ok = (await call(server, { service: "AdminService", method: "wipe" }, { identity: { isSystem: true } })) as KeymaLeafSuccess<string>;
        assert.equal(ok.data, "wiped");
    });

    it("batches a call alongside a CRUD op in one request", async () => {
        const { server } = makeServer();
        const resp = await server.handle({
            operations: {
                n: { op: "count", schema: "organization" },
                g: { op: "call", service: "GreetService", method: "shout", args: { text: "hi" } },
            },
        });
        assert.equal((resp.results["n"] as KeymaLeafSuccess<number>).data, 0);
        assert.equal((resp.results["g"] as KeymaLeafSuccess<string>).data, "HI");
    });
});

describe("call — plugin hooks", () => {
    it("runs op-level hooks (transform/before/after) for a call op without crashing on op.schema", async () => {
        const events: string[] = [];
        const plugin: KeymaServerPlugin = {
            name: "spy",
            transformOperation(_ctx, op) {
                events.push(`transform:${op.op}`);
                // A real plugin must guard schema access since calls have no schema.
                if ("schema" in op) events.push(`schema:${op.schema}`);
                return undefined;
            },
            beforeOperation(_ctx, op) {
                events.push(`before:${op.op}`);
            },
            afterOperation(_ctx, op, result) {
                events.push(`after:${op.op}:${result.ok}`);
            },
        };
        const { server } = makeServer([plugin]);
        await call(server, { service: "GreetService", method: "shout", args: { text: "x" } });
        assert.deepEqual(events, ["transform:call", "before:call", "after:call:true"]);
    });
});

describe("Keyma.call — client builder", () => {
    it("builds a call op, substitutes inputs, and hydrates a schema return", async () => {
        const { server } = makeServer();
        const transport = createDirectTransport(server);
        const doc = Keyma.mutation({
            g: Keyma.call(GreetService, "greet", { input: { name: "Ada" } }),
        });
        const { results } = await doc.request({}, { inputs: {}, transport });
        assert.equal(results.g.ok, true);
        const data = (results.g as KeymaLeafSuccess<GreetResultRecord>).data;
        assert.ok(data instanceof GreetResultCtor);
        assert.equal(data.message, "Hi Ada");
    });

    it("passes a primitive return through without hydration", async () => {
        const { server } = makeServer();
        const transport = createDirectTransport(server);
        const doc = Keyma.mutation({ s: Keyma.call(GreetService, "shout", { text: "loud" }) });
        const { results } = await doc.request({}, { inputs: {}, transport });
        assert.equal((results.s as KeymaLeafSuccess<string>).data, "LOUD");
    });

    it("substitutes an Input placeholder into call args", async () => {
        const { server } = makeServer();
        const transport = createDirectTransport(server);
        const doc = Keyma.mutation({ s: Keyma.call(GreetService, "shout", { text: Keyma.input("t") }) });
        const { results } = await doc.request({}, { inputs: { s: { t: "param" } }, transport });
        assert.equal((results.s as KeymaLeafSuccess<string>).data, "PARAM");
    });
});

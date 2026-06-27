// End-to-end @Service over the in-process direct transport, for BOTH wire encodings. The
// generated-shape server (a `dispatch` switch + `static service`) and client (a `ServiceClient`
// subclass) are hand-rolled here to mirror exactly what `emit-service.ts` produces, so this
// exercises the whole RPC stack: client marshalling → transport → host resolve/gate/inject →
// dispatch decode/call/encode → envelope unwrap → result hydration.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ServiceHost } from "../src/service-host.js";
import { createDirectTransport } from "../src/direct-transport.js";
import { ServiceClient } from "../src/client.js";
import { decodeArgs, encodeResult } from "../src/rpc.js";
import { KeymaError } from "../src/errors.js";
import type { RequestContext, WireEncoding } from "../src/types.js";
import type { ClassRef, FieldType } from "../src/fields.js";
import { defineClass } from "./helpers.js";

// ── Generated-shape model + service (mirrors compiler output) ──────────────────

const User = defineClass({
    name: "User",
    fields: [
        { name: "id", type: { kind: "id" } },
        { name: "name", type: { kind: "string" } },
    ],
});
const REFS = new Map<string, ClassRef>([["User", User]]);

const T_USER: FieldType = { kind: "instance", name: "User" };
const T_STRING: FieldType = { kind: "string" };

type UserRec = { id: string; name: string };

abstract class UserServiceServer {
    static service = Object.freeze({
        name: "User",
        methods: [
            { name: "create" },
            { name: "greet" },
            { name: "whoami" },
            { name: "boom" },
            { name: "wipe", visibility: "private" as const },
        ],
    });

    abstract create(name: string, ctx: RequestContext): unknown;
    abstract greet(user: unknown, ctx: RequestContext): string;
    abstract whoami(ctx: RequestContext): string;
    abstract boom(ctx: RequestContext): never;
    abstract wipe(ctx: RequestContext): void;

    async dispatch(method: string, payload: unknown, ctx: RequestContext, encoding: WireEncoding): Promise<unknown> {
        switch (method) {
            case "create": {
                const [name] = decodeArgs(encoding, payload, [{ name: "name", type: T_STRING }], REFS);
                return encodeResult(encoding, await this.create(name as string, ctx), T_USER, REFS);
            }
            case "greet": {
                const [user] = decodeArgs(encoding, payload, [{ name: "user", type: T_USER }], REFS);
                return encodeResult(encoding, await this.greet(user, ctx), T_STRING, REFS);
            }
            case "whoami":
                return encodeResult(encoding, await this.whoami(ctx), T_STRING, REFS);
            case "boom":
                return encodeResult(encoding, await this.boom(ctx), T_STRING, REFS);
            case "wipe":
                return encodeResult(encoding, await this.wipe(ctx), undefined, REFS);
            default:
                throw new KeymaError("METHOD_NOT_FOUND", `Unknown method "${method}"`);
        }
    }
}

class UserServiceImpl extends UserServiceServer {
    create(name: string): unknown {
        return User.fromValue({ id: "u-" + name, name });
    }
    greet(user: unknown): string {
        return `hi ${(user as UserRec).name}`;
    }
    whoami(ctx: RequestContext): string {
        return (ctx.identity?.id as string | undefined) ?? "anonymous";
    }
    boom(): never {
        throw new Error("handler exploded");
    }
    wipe(): void {
        // system-only side effect — body irrelevant to the gating test.
    }
}

class UserServiceClient extends ServiceClient {
    create(name: string): Promise<unknown> {
        return this._call("User", "create", [{ name: "name", type: T_STRING, value: name }], T_USER, REFS);
    }
    greet(user: unknown): Promise<unknown> {
        return this._call("User", "greet", [{ name: "user", type: T_USER, value: user }], T_STRING, REFS);
    }
    whoami(): Promise<unknown> {
        return this._call("User", "whoami", [], T_STRING, REFS);
    }
    boom(): Promise<unknown> {
        return this._call("User", "boom", [], T_STRING, REFS);
    }
    wipe(): Promise<unknown> {
        return this._call("User", "wipe", [], undefined, REFS);
    }
}

// ── Tests (both encodings) ─────────────────────────────────────────────────────

for (const encoding of ["json", "binary"] as WireEncoding[]) {
    describe(`@Service over direct transport — ${encoding}`, () => {
        const host = new ServiceHost({ services: [() => new UserServiceImpl()] });
        const client = new UserServiceClient(createDirectTransport(host, { encoding }));

        it("round-trips a class-typed return (hydrated to a User instance)", async () => {
            const u = (await client.create("ada")) as UserRec;
            assert.ok(u instanceof (User as unknown as new () => object));
            assert.equal(u.id, "u-ada");
            assert.equal(u.name, "ada");
        });

        it("round-trips a class-typed argument", async () => {
            const u = User.fromValue({ id: "u1", name: "grace" });
            assert.equal(await client.greet(u), "hi grace");
        });

        it("forwards the request context to the impl (last arg)", async () => {
            const ctxClient = new UserServiceClient(
                createDirectTransport(host, { encoding, context: () => ({ identity: { id: "caller-1" } }) }),
            );
            assert.equal(await ctxClient.whoami(), "caller-1");
        });

        it("gates a private method as not found for non-system callers", async () => {
            await assert.rejects(
                () => client.wipe(),
                (e: unknown) => e instanceof KeymaError && e.code === "METHOD_NOT_FOUND",
            );
        });

        it("the system identity bypasses the visibility gate", async () => {
            const sys = new UserServiceClient(createDirectTransport(host, { encoding, isSystem: true }));
            assert.equal(await sys.wipe(), undefined); // void return resolves cleanly
        });

        it("folds a thrown handler error into a HANDLER_ERROR envelope", async () => {
            await assert.rejects(
                () => client.boom(),
                (e: unknown) => e instanceof KeymaError && e.code === "HANDLER_ERROR" && /exploded/.test(e.message),
            );
        });
    });
}

describe("ServiceHost — resolution", () => {
    it("reports an unknown service as SERVICE_NOT_FOUND", async () => {
        const host = new ServiceHost({ services: [new UserServiceImpl()] });
        const result = await host.invoke({ service: "Nope", method: "x", args: {} });
        assert.equal(result.ok, false);
        assert.equal((result as { code: string }).code, "SERVICE_NOT_FOUND");
    });

    it("reports an unknown method as METHOD_NOT_FOUND", async () => {
        const host = new ServiceHost({ services: [new UserServiceImpl()] });
        const result = await host.invoke({ service: "User", method: "nope", args: {} });
        assert.equal(result.ok, false);
        assert.equal((result as { code: string }).code, "METHOD_NOT_FOUND");
    });
});

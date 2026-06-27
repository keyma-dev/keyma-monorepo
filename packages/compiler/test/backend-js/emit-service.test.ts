import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRService, IRServiceMethod, IRType, KeymaIR } from "@keyma/core/ir";
import {
    emitServicesJs, emitServicesDts, createJsBackend, type ServiceEmitDeps,
} from "../../src/backend-js/index.js";

const SRC = { file: "svc.ts", line: 1, column: 1 };

function method(over: Partial<IRServiceMethod> & Pick<IRServiceMethod, "name">): IRServiceMethod {
    return { params: [], visibility: "public", source: SRC, ...over };
}
function service(over: Partial<IRService> & Pick<IRService, "name" | "sourceName">): IRService {
    return { id: `service:${over.name}`, visibility: "public", methods: [], source: SRC, ...over };
}

const T_STR: IRType = { kind: "string" };
const T_USER: IRType = { kind: "instance", name: "User" };

// Deps for a service referencing the `User` model class (authored in src/user.ts).
const clientDeps: ServiceEmitDeps = {
    includePrivate: false,
    classModule: new Map([["User", "src/user"]]),
    embeddedTypeNames: new Map([["User", "User"]]),
};
const serverDeps: ServiceEmitDeps = { ...clientDeps, includePrivate: true };

const GREETER = service({
    name: "Greeter",
    sourceName: "Greeter",
    methods: [
        method({ name: "ping", params: [{ name: "msg", type: T_STR }], returnType: T_STR }),
        method({ name: "create", params: [{ name: "data", type: T_USER }], returnType: T_USER }),
        method({ name: "noop" }),
        method({ name: "wipe", visibility: "private" }),
    ],
});

// ─── client services.js ────────────────────────────────────────────────────────
describe("emitServicesJs — client bundle", () => {
    const js = emitServicesJs([GREETER], clientDeps);

    it("imports the runtime ServiceClient from the bundle-local baked module (not @keyma/runtime)", () => {
        assert.ok(js.includes(`import { ServiceClient } from "./client.js";`), js);
        assert.ok(!js.includes("@keyma/runtime"), js);
    });

    it("imports referenced model classes for the refs Map", () => {
        assert.ok(js.includes(`import { User } from "./src/user.js";`), js);
        assert.ok(js.includes(`const Greeter__refs = new Map([["User", User]]);`), js);
    });

    it("emits a concrete class extending ServiceClient", () => {
        assert.ok(js.includes("export class Greeter extends ServiceClient {"), js);
    });

    it("each method body is a single _call with the encoded args + return type literal", () => {
        assert.ok(
            js.includes(`return this._call("Greeter", "ping", [{ name: "msg", type: {`) &&
            js.includes(`}, value: msg }], {`),
            js,
        );
        // The class-typed return rides as an `instance` literal.
        assert.ok(js.includes(`"kind": "instance"`) && js.includes(`"name": "User"`), js);
    });

    it("gates private methods out of the client bundle", () => {
        assert.ok(!js.includes("wipe"), js);
    });
});

// ─── server services.js ────────────────────────────────────────────────────────
describe("emitServicesJs — server bundle", () => {
    const js = emitServicesJs([GREETER], serverDeps);

    it("imports the marshaller + error from the baked modules (not @keyma/runtime)", () => {
        assert.ok(js.includes(`import { decodeArgs, encodeResult } from "./rpc.js";`), js);
        assert.ok(js.includes(`import { KeymaError } from "./errors.js";`), js);
        assert.ok(!js.includes("@keyma/runtime"), js);
    });

    it("emits a generated dispatch(method, payload, ctx, encoding)", () => {
        assert.ok(js.includes("async dispatch(method, payload, ctx, encoding) {"), js);
        assert.ok(js.includes(`switch (method) {`), js);
        assert.ok(js.includes(`case "ping": {`), js);
    });

    it("decodes args, guards unimplemented methods, calls the impl with ctx last, encodes the result", () => {
        assert.ok(js.includes(`const args = decodeArgs(encoding, payload, [`), js);
        assert.ok(js.includes(`if (typeof this.ping !== "function") throw new KeymaError("METHOD_NOT_IMPLEMENTED"`), js);
        assert.ok(js.includes(`return encodeResult(encoding, await this.ping(args[0], ctx),`), js);
        // void method: no args, ctx only.
        assert.ok(js.includes(`await this.noop(ctx)`), js);
    });

    it("falls through to METHOD_NOT_FOUND for an unknown method", () => {
        assert.ok(js.includes(`throw new KeymaError("METHOD_NOT_FOUND"`), js);
    });

    it("attaches the slim static service metadata (name + per-method visibility)", () => {
        assert.ok(js.includes(`Greeter.service = Object.freeze({`), js);
        assert.ok(js.includes(`"name": "wipe"`) && js.includes(`"visibility": "private"`), js);
    });

    it("includes private methods in the server dispatch", () => {
        assert.ok(js.includes(`case "wipe": {`), js);
    });
});

// ─── .d.ts ─────────────────────────────────────────────────────────────────────
describe("emitServicesDts", () => {
    it("client: a concrete class bound via ServiceClient, async data-only signatures", () => {
        const dts = emitServicesDts([GREETER], clientDeps);
        assert.ok(dts.includes(`import { ServiceClient } from "./client.js";`), dts);
        assert.ok(dts.includes(`import type { User } from "./src/user.js";`), dts);
        assert.ok(dts.includes("export declare class Greeter extends ServiceClient {"), dts);
        assert.ok(dts.includes("ping(msg: string): Promise<string>;"), dts);
        assert.ok(dts.includes("create(data: User): Promise<User>;"), dts);
        assert.ok(!dts.includes("wipe"), dts);
    });

    it("server: an abstract base with ctx injected last + a concrete dispatch", () => {
        const dts = emitServicesDts([GREETER], serverDeps);
        assert.ok(dts.includes(`import type { ServiceMetadata, RequestContext, WireEncoding } from "./types.js";`), dts);
        assert.ok(dts.includes("export declare abstract class Greeter {"), dts);
        assert.ok(dts.includes("static readonly service: ServiceMetadata;"), dts);
        assert.ok(dts.includes("abstract ping(msg: string, ctx: RequestContext): Promise<string>;"), dts);
        assert.ok(dts.includes("dispatch(method: string, payload: unknown, ctx: RequestContext, encoding: WireEncoding): Promise<unknown>;"), dts);
        assert.ok(dts.includes("abstract wipe(ctx: RequestContext): Promise<void>;"), dts);
    });
});

// ─── full bundle: self-containment ───────────────────────────────────────────────
describe("createJsBackend — bundle emits baked runtime, imports no @keyma/runtime", () => {
    const ir: KeymaIR = {
        irVersion: "1",
        compilerVersion: "test",
        classes: [],
        services: [service({
            name: "Pinger",
            sourceName: "Pinger",
            methods: [method({ name: "ping", params: [{ name: "msg", type: T_STR }], returnType: T_STR })],
        })],
        diagnostics: [],
    };

    it("emits the baked codec/RPC modules into both bundles and never imports @keyma/runtime", async () => {
        const backend = createJsBackend([]);
        const result = await backend.emit(ir, { language: "js", outDir: "out" }, {
            source: [], outDir: "out", namePrefix: "", targets: [],
        });
        const paths = new Set(result.files.map((f) => f.path));

        for (const bundle of ["out/client", "out/server"]) {
            for (const mod of ["client", "rpc", "errors", "service-host", "direct-transport", "binary", "serialize", "fields"]) {
                assert.ok(paths.has(`${bundle}/${mod}.js`), `${bundle}/${mod}.js missing`);
                assert.ok(paths.has(`${bundle}/${mod}.d.ts`), `${bundle}/${mod}.d.ts missing`);
            }
            assert.ok(paths.has(`${bundle}/services.js`), `${bundle}/services.js missing`);
        }

        for (const f of result.files) {
            const content = typeof f.content === "string" ? f.content : "";
            assert.ok(!content.includes("@keyma/runtime"), `${f.path} imports @keyma/runtime`);
        }
    });
});

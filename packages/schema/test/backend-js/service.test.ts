import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { KeymaIR } from "@keyma/core/ir";
import { emitJs } from "./harness.js";
import type { JsTargetConfig } from "@keyma/compiler/backend-js";

const ROOT = process.platform === "win32" ? "C:\\project" : "/project";
const SRC_DIR = path.join(ROOT, "src");
const loc = { file: path.join(SRC_DIR, "svc.ts"), line: 1, column: 1 };

function ephemeral(name: string, sourceName: string) {
    return {
        name,
        sourceName,
        visibility: "public" as const,
        ephemeral: true,
        fields: [
            {
                name: "v",
                type: { kind: "string" as const },
                visibility: "public" as const,
                readonly: false,
                required: true,
                validators: [],
                formatters: [],
                indexes: [],
                source: loc,
            },
        ],
        indexes: [],
        source: loc,
    };
}

const IR: KeymaIR = {
    irVersion: "3.1.0",
    compilerVersion: "0.1.0",
    sourceRoot: SRC_DIR,
    classes: [ephemeral("in", "In"), ephemeral("out", "Out")],
    services: [
        {
            id: "service:Greeter",
            name: "Greeter",
            sourceName: "Greeter",
            visibility: "public",
            methods: [
                {
                    name: "greet",
                    params: [{ name: "input", type: { kind: "reference", target: "in" } }],
                    returnType: { kind: "reference", target: "out" },
                    visibility: "public",
                    source: loc,
                },
                {
                    name: "secret",
                    params: [],
                    visibility: "private",
                    source: loc,
                },
            ],
            source: loc,
        },
    ],
    diagnostics: [],
};

const target: JsTargetConfig = { language: "js", outDir: "dist" };
const config = { source: [], outDir: "dist", namePrefix: "", targets: [target] };

function fileContent(files: { path: string; content: string | Uint8Array }[], p: string): string {
    const f = files.find((f) => f.path === p);
    assert.ok(f !== undefined, `missing ${p}`);
    return f!.content as string;
}

describe("JS Backend — services", () => {
    it("emits a transport-bound client class (public methods only) with a refs Map", async () => {
        const { files } = await emitJs(IR, target, config);

        const js = fileContent(files, "dist/client/services.js");
        // The RPC rewrite replaced the branded `Keyma.call` stub with a concrete client class
        // bound to a Transport (`new Greeter(transport).greet(...)`), backed by the baked runtime.
        assert.ok(js.includes('import { ServiceClient } from "./client.js";'));
        assert.ok(js.includes("export class Greeter extends ServiceClient {"));
        // One `<Service>__refs` Map drives class-typed arg/return marshalling (param + return).
        assert.ok(js.includes("const Greeter__refs = new Map(") && js.includes('["out", Out]'), "client carries refs for return hydration");
        assert.ok(js.includes('import { In, Out } from "./src/svc.js"'));
        assert.ok(!js.includes("secret"), "private method excluded from client");

        const dts = fileContent(files, "dist/client/services.d.ts");
        // Types come from the inlined local modules, not @keyma/runtime/schema or a dsl brand.
        assert.ok(dts.includes('import { ServiceClient } from "./client.js";'));
        assert.ok(!dts.includes("@keyma/runtime/schema") && !dts.includes("@keyma/core/dsl"));
        assert.ok(dts.includes("export declare class Greeter extends ServiceClient {"));
        assert.ok(dts.includes("greet(input: In): Promise<Out>;"), "client method is async, ctx-free");
        assert.ok(!dts.includes("secret"));
    });

    it("emits an extendable abstract class on the server (ctx appended, dispatch)", async () => {
        const { files } = await emitJs(IR, target, config);

        const dts = fileContent(files, "dist/server/services.d.ts");
        assert.ok(dts.includes("import type { ServiceMetadata, RequestContext, WireEncoding } from \"./types.js\""));
        assert.ok(!dts.includes("@keyma/runtime/schema") && !dts.includes("@keyma/core/dsl"));
        assert.ok(dts.includes("export declare abstract class Greeter {"));
        assert.ok(dts.includes("static readonly service: ServiceMetadata;"));
        assert.ok(dts.includes("abstract greet(input: In, ctx: RequestContext): Promise<Out>;"));
        assert.ok(dts.includes("abstract secret(ctx: RequestContext): Promise<void>;"), "private method present in server");
        assert.ok(dts.includes("dispatch(method: string, payload: unknown, ctx: RequestContext, encoding: WireEncoding): Promise<unknown>;"));

        const js = fileContent(files, "dist/server/services.js");
        // The server emits a generated dispatch over the baked marshaller (decodeArgs/encodeResult),
        // with its own refs Map for class-typed arg/return marshalling.
        assert.ok(js.includes("async dispatch(method, payload, ctx, encoding) {"), "server emits generated dispatch");
        assert.ok(js.includes("const args = decodeArgs(encoding, payload,"), "server dispatch decodes args via the baked marshaller");
        assert.ok(js.includes('"name": "secret"'));
    });

    it("re-exports the service from the bundle index", async () => {
        const { files } = await emitJs(IR, target, config);
        const indexJs = fileContent(files, "dist/client/index.js");
        assert.ok(indexJs.includes('export { Greeter } from "./services.js";'));
    });
});

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
    it("emits a branded client stub (public methods only) with a refs Map", async () => {
        const { files } = await emitJs(IR, target, config);

        const js = fileContent(files, "dist/client/services.js");
        assert.ok(js.includes("export class Greeter {}"));
        assert.ok(js.includes("Greeter.service = Object.freeze("));
        assert.ok(js.includes('new Map([["out", Out]])'), "client carries refs for return hydration");
        assert.ok(js.includes('import { Out } from "./src/svc.js"'));
        assert.ok(!js.includes("secret"), "private method excluded from client");

        const dts = fileContent(files, "dist/client/services.d.ts");
        // Types come from the inlined local module, not @keyma/runtime/schema, and there's no dsl brand.
        assert.ok(dts.includes("import type { ServiceMetadata } from \"./types.js\""));
        assert.ok(!dts.includes("@keyma/runtime/schema") && !dts.includes("@keyma/core/dsl"));
        // The branded abstract class exposes the (async) methods for editor type-checking…
        assert.ok(dts.includes("declare abstract class _Greeter {"));
        assert.ok(dts.includes("abstract greet(input: In): Promise<Out>;"), "client method is async, ctx-free");
        // …and the structural `__service` marker carries the contract that drives Keyma.call inference.
        assert.ok(dts.includes("export declare const Greeter: typeof _Greeter & { readonly __service?: {"));
        assert.ok(dts.includes("greet: { args: { input: In }; ret: Out };"));
        assert.ok(!dts.includes("secret"));
    });

    it("emits an extendable abstract class on the server (ctx appended, async methods)", async () => {
        const { files } = await emitJs(IR, target, config);

        const dts = fileContent(files, "dist/server/services.d.ts");
        assert.ok(dts.includes("import type { ServiceMetadata, RequestContext } from \"./types.js\""));
        assert.ok(!dts.includes("@keyma/runtime/schema") && !dts.includes("@keyma/core/dsl"));
        assert.ok(dts.includes("export declare abstract class Greeter {"));
        assert.ok(dts.includes("static readonly service: ServiceMetadata;"));
        assert.ok(dts.includes("abstract greet(input: In, ctx: RequestContext): Promise<Out>;"));
        assert.ok(dts.includes("abstract secret(ctx: RequestContext): Promise<void>;"), "private method present in server");

        const js = fileContent(files, "dist/server/services.js");
        assert.ok(!js.includes("new Map("), "server omits the client refs Map");
        assert.ok(js.includes('"name": "secret"'));
    });

    it("re-exports the service from the bundle index", async () => {
        const { files } = await emitJs(IR, target, config);
        const indexJs = fileContent(files, "dist/client/index.js");
        assert.ok(indexJs.includes('export { Greeter } from "./services.js";'));
    });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KeymaIR } from "@keyma/core/ir";
import { createJsBackend } from "@keyma/compiler/backend-js";
import type { JsTargetConfig } from "@keyma/compiler/backend-js";
import { uiJsEmitterPack } from "../../src/backend-js/index.js";

const target: JsTargetConfig = { language: "js", outDir: "dist", library: true };
const config = { source: [], outDir: "dist", schemaPrefix: "", targets: [target] };

const IR_WITH_UI: KeymaIR = {
    irVersion: "1.0.0",
    compilerVersion: "0.1.0",
    sourceRoot: "/p/src",
    schemas: [],
    diagnostics: [],
    extensions: {
        ui: {
            views: [
                { name: "UserView", title: "Users", route: "/users", widgets: [{ field: "name", kind: "text" }] },
            ],
        },
    },
};

describe("uiJsEmitterPack.emitBundleFiles", () => {
    it("emits ui/views.{js,d.ts} from extensions.ui", async () => {
        const backend = createJsBackend([uiJsEmitterPack]);
        const { files } = await backend.emit(IR_WITH_UI, target, config);

        const viewsJs = files.find((f) => f.path === "dist/ui/views.js");
        assert.ok(viewsJs !== undefined, "dist/ui/views.js emitted");
        const content = viewsJs.content as string;
        assert.ok(content.includes("export const views ="), "exports a views constant");
        assert.ok(content.includes(`"route": "/users"`), "embeds the view metadata");
        assert.ok(files.some((f) => f.path === "dist/ui/views.d.ts"), "dist/ui/views.d.ts emitted");
    });

    it("emits no ui/ files when extensions.ui is absent", async () => {
        const backend = createJsBackend([uiJsEmitterPack]);
        const irNoUi: KeymaIR = {
            irVersion: "1.0.0",
            compilerVersion: "0.1.0",
            sourceRoot: "/p/src",
            schemas: [],
            diagnostics: [],
        };
        const { files } = await backend.emit(irNoUi, target, config);
        assert.equal(files.filter((f) => f.path.includes("/ui/")).length, 0);
    });
});

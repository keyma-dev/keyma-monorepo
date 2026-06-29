// The UI domain no longer ships a JS emitter pack: a `@UiView` class carries a synthesized `view`
// STATIC member (a `{kind:"json"}` blob), and the compiler's generic static-member emission renders
// it into the class module. This test drives the real JS backend over a UI-bearing IR and asserts
// the `view` static lands in the class's `.js` (structured literal) + `.d.ts` (`unknown`), and that a
// plain class gets none. The schema domain's neutral `classMetadata` builder is passed only to supply
// the per-class metadata the JS backend requires (@keyma/schema is a test-only devDependency of @keyma/ui).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual } from "@keyma/compiler/frontend-ts";
import { createJsBackend } from "@keyma/compiler/backend-js";
import type { JsTargetConfig } from "@keyma/compiler/backend-js";
import type { KeymaIR } from "@keyma/core/ir";
import type { ResolvedConfig, EmitFile } from "@keyma/compiler";
import { schemaFrontendDomain } from "@keyma/schema/frontend-ts";
import { buildClassMetadata, EMITTED_SCHEMA_TYPES_DTS } from "@keyma/schema";
import { uiFrontendDomain } from "../../src/frontend-ts/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(__dirname, "..", "..", "src", "frontend-ts");
const target: JsTargetConfig = { language: "js", outDir: "dist", library: true };
const config = { source: [], outDir: "dist", schemaPrefix: "", targets: [] } as unknown as ResolvedConfig;

function compile(src: string): KeymaIR {
    return compileVirtual({ "views.ts": src }, { baseDir: BASE, domains: [schemaFrontendDomain, uiFrontendDomain] }).ir;
}

async function emitJs(ir: KeymaIR): Promise<EmitFile[]> {
    const backend = createJsBackend({ classMetadata: buildClassMetadata, runtimeTypeDecls: [() => EMITTED_SCHEMA_TYPES_DTS] });
    return (await backend.emit(ir, target, config)).files;
}

/** The emitted module file (.js or .d.ts) whose content names `needle`. */
function moduleWith(files: EmitFile[], suffix: string, needle: string): EmitFile | undefined {
    return files.find((f) => f.path.endsWith(suffix) && (f.content as string).includes(needle));
}

describe("UI `view` static — JS backend emission", () => {
    it("emits the synthesized `view` static into the @UiView class's module (.js + .d.ts)", async () => {
        const files = await emitJs(compile(`
import { UiView, Widget } from "@keyma/ui/dsl";
@UiView({ title: "Users", route: "/users" })
export class UserView {
    @Widget("text") declare name: string;
    @Widget("toggle") declare active: boolean;
}
`));

        const js = moduleWith(files, ".js", "class UserView");
        assert.ok(js !== undefined, "the UserView module .js was emitted");
        const content = js.content as string;
        assert.match(content, /UserView\.view = \{/, "assigns a structured `view` static");
        assert.match(content, /"name": "UserView"/);
        assert.match(content, /"route": "\/users"/);
        assert.match(content, /"field": "name", "kind": "text"/);
        assert.match(content, /"field": "active", "kind": "toggle"/);

        const dts = files.find((f) => f.path === js.path.replace(/\.js$/, ".d.ts"));
        assert.ok(dts !== undefined, "the UserView module .d.ts was emitted");
        assert.match(dts.content as string, /static readonly view: unknown;/, "the json static types as `unknown`");
    });

    it("emits no `view` static for a class with no @UiView", async () => {
        const files = await emitJs(compile(`export class Plain { declare x: string; }`));
        const js = moduleWith(files, ".js", "class Plain");
        assert.ok(js !== undefined, "the Plain module .js was emitted");
        assert.doesNotMatch(js.content as string, /Plain\.view/, "a non-@UiView class gets no view static");
    });
});

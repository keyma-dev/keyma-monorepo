// The Phase-5 acceptance test: a fixture compiled with `domains: ['schema', 'ui']` must leave
// every schema artifact byte-identical to a schema-only build, while the UI domain contributes
// only its own `ui/` files. This is the proof that a second domain plugs into all four seams
// (DSL recognition, frontend extraction, IR extensions, per-language emission) without touching
// the generic core/compiler or the schema domain. @keyma/schema is a devDependency of @keyma/ui
// (test-only; it is NOT a runtime/publish dependency, so the package graph stays acyclic).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileVirtual } from "@keyma/compiler/frontend-ts";
import { createJsBackend } from "@keyma/compiler/backend-js";
import { createPythonBackend } from "@keyma/compiler/backend-python";
import { createCppBackend } from "@keyma/compiler/backend-cpp";
import { drive } from "@keyma/compiler";
import { validateIR, defaultIRValidators } from "@keyma/core/ir";
import type { KeymaIR } from "@keyma/core/ir";
import type { KeymaBackend, KeymaFrontend, KeymaTargetConfig, ResolvedConfig, EmitFile } from "@keyma/compiler";
import type { FrontendDomain } from "@keyma/compiler/frontend-ts";

import { schemaFrontendDomain } from "@keyma/schema/frontend-ts";
import { schemaIRValidator } from "@keyma/schema/ir";
import { schemaJsEmitterPack } from "@keyma/schema/backend-js";
import { schemaPythonEmitterPack } from "@keyma/schema/backend-python";
import { schemaCppEmitterPack } from "@keyma/schema/backend-cpp";

import { uiFrontendDomain } from "../src/frontend-ts/index.js";
import { uiJsEmitterPack } from "../src/backend-js/index.js";
import { uiPythonEmitterPack } from "../src/backend-python/index.js";
import { uiCppEmitterPack } from "../src/backend-cpp/index.js";

// Register the schema-domain IR validator exactly as the CLI does, so validateIR runs the full
// envelope + schema-section checks against the UI-bearing document below.
defaultIRValidators.register(schemaIRValidator);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A directory under packages/ui from which both @keyma/schema/dsl and @keyma/ui/dsl resolve.
const BASE = path.join(__dirname, "..", "..", "src", "frontend-ts");

// One source file exercising both domains: a @Schema class and a @UiView class side by side.
const SRC = `
import { Schema, Indexed } from "@keyma/schema/dsl";
import { UiView, Widget } from "@keyma/ui/dsl";

@Schema({ name: "user" })
export class User {
    @Indexed({ unique: true }) declare id: string;
    declare email: string;
}

@UiView({ title: "Users", route: "/users" })
export class UserView {
    @Widget("text") declare name: string;
    @Widget("toggle") declare active: boolean;
}
`;

const config = { source: [], outDir: "dist", schemaPrefix: "", targets: [] } as unknown as ResolvedConfig;

function ir(domains: FrontendDomain[]): KeymaIR {
    return compileVirtual({ "app.ts": SRC }, { baseDir: BASE, domains }).ir;
}

function target(language: string): KeymaTargetConfig {
    return { language, outDir: "dist", library: true } as unknown as KeymaTargetConfig;
}

async function emit(backend: KeymaBackend, doc: KeymaIR, language: string): Promise<EmitFile[]> {
    return (await backend.emit(doc, target(language), config)).files;
}

function byPath(files: EmitFile[]): Map<string, string> {
    return new Map(files.map((f) => [f.path, f.content as string]));
}

/**
 * Assert that adding the UI domain (a) leaves every schema-only file present and
 * byte-identical, and (b) adds only files under a `ui/` directory.
 */
function assertNonInterference(language: string, schemaOnly: EmitFile[], both: EmitFile[]): void {
    const base = byPath(schemaOnly);
    const combined = byPath(both);

    for (const [p, content] of base) {
        assert.ok(combined.has(p), `${language}: ${p} dropped when the ui domain was added`);
        assert.equal(combined.get(p), content, `${language}: ${p} content changed when the ui domain was added`);
    }

    const extra = [...combined.keys()].filter((p) => !base.has(p));
    assert.ok(extra.length > 0, `${language}: ui domain contributed at least one file`);
    for (const p of extra) {
        assert.ok(/(^|\/)ui\//.test(p), `${language}: extra file ${p} must live under ui/`);
    }
}

describe("non-interference: domains ['schema','ui']", () => {
    const irSchemaOnly = ir([schemaFrontendDomain]);
    const irBoth = ir([schemaFrontendDomain, uiFrontendDomain]);

    it("the UI domain leaves the schema IR sections untouched", () => {
        assert.deepEqual(irBoth.classes, irSchemaOnly.classes, "schemas identical with/without the ui domain");
        assert.equal(irSchemaOnly.extensions, undefined, "schema-only IR has no extensions");
        const ui = irBoth.extensions?.["ui"] as { views: unknown[] } | undefined;
        assert.ok(ui !== undefined, "ui extension present under extensions.ui");
        assert.equal(ui.views.length, 1, "the @UiView class was extracted");
    });

    it("does not pollute the top-level schema/service arrays", () => {
        // The UI domain returns empty schemas/services — its data rides only in extensions.ui.
        assert.equal(irBoth.classes.length, irSchemaOnly.classes.length);
        assert.equal(irBoth.services?.length ?? 0, irSchemaOnly.services?.length ?? 0);
    });

    it("JS: schema output byte-identical; ui contributes only ui/ files", async () => {
        const schemaOnly = await emit(createJsBackend([schemaJsEmitterPack]), irSchemaOnly, "js");
        const both = await emit(createJsBackend([schemaJsEmitterPack, uiJsEmitterPack]), irBoth, "js");
        assertNonInterference("js", schemaOnly, both);
        assert.ok([...byPath(both).keys()].includes("dist/ui/views.js"));
    });

    it("Python: schema output byte-identical; ui contributes only ui/ files", async () => {
        const schemaOnly = await emit(createPythonBackend([schemaPythonEmitterPack]), irSchemaOnly, "python");
        const both = await emit(createPythonBackend([schemaPythonEmitterPack, uiPythonEmitterPack]), irBoth, "python");
        assertNonInterference("python", schemaOnly, both);
        assert.ok([...byPath(both).keys()].includes("dist/ui/views.py"));
    });

    it("C++: schema output byte-identical; ui contributes only ui/ files", async () => {
        const schemaOnly = await emit(createCppBackend([schemaCppEmitterPack]), irSchemaOnly, "cpp");
        const both = await emit(createCppBackend([schemaCppEmitterPack, uiCppEmitterPack]), irBoth, "cpp");
        assertNonInterference("cpp", schemaOnly, both);
        assert.ok([...byPath(both).keys()].includes("dist/ui/views.hpp"));
    });

    it("a UI-bearing IR passes validateIR (envelope + schema-domain checks)", () => {
        const result = validateIR(irBoth as unknown as Record<string, unknown>);
        assert.equal(result.valid, true, `validation errors: ${JSON.stringify(result.errors)}`);
    });
});

// The full pipeline the CLI runs: frontend (both domains) → validateIR → backends → EmitFiles.
// This is the only test that exercises drive()/validateIR against a UI-bearing document, closing
// the gap that the package-level emission tests above bypass.
describe("end-to-end via drive() with both domains", () => {
    const frontend: KeymaFrontend = {
        name: "test",
        sourceExtensions: [".ts"],
        compile: async () => {
            const { ir, diagnostics } = compileVirtual({ "app.ts": SRC }, { baseDir: BASE, domains: [schemaFrontendDomain, uiFrontendDomain] });
            return { ir, diagnostics };
        },
    };
    const backends: KeymaBackend[] = [
        createJsBackend([schemaJsEmitterPack, uiJsEmitterPack]),
        createPythonBackend([schemaPythonEmitterPack, uiPythonEmitterPack]),
        createCppBackend([schemaCppEmitterPack, uiCppEmitterPack]),
    ];
    const driveConfig = {
        source: [],
        outDir: "dist",
        schemaPrefix: "",
        targets: [target("js"), target("python"), target("cpp")],
    } as unknown as ResolvedConfig;

    it("drives cleanly (no IR-validation errors) and emits schema models + ui views per language", async () => {
        const result = await drive(driveConfig, frontend, backends);
        assert.equal(result.hasErrors, false, `drive diagnostics: ${JSON.stringify(result.diagnostics)}`);

        const paths = result.emitted.map((f) => f.path);
        // Schema models present (the @Schema class lowered + emitted) …
        assert.ok(paths.some((p) => /models\/app\.(js|py|hpp)$/.test(p)), "schema models emitted");
        // … alongside the UI views file in every language, only under ui/.
        assert.ok(paths.some((p) => p.endsWith("ui/views.js")), "ui/views.js emitted");
        assert.ok(paths.some((p) => p.endsWith("ui/views.py")), "ui/views.py emitted");
        assert.ok(paths.some((p) => p.endsWith("ui/views.hpp")), "ui/views.hpp emitted");
    });
});

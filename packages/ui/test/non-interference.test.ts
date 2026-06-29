// The acceptance test for the FRONTEND-ONLY UI domain: compiling with `domains: ['schema','ui']`
// must leave every NON-`@UiView` artifact byte-identical to a schema-only build, while a `@UiView`
// class gains a synthesized `view` STATIC (its only change) — and there are NO separate `ui/` files
// anymore (the UI domain ships no backend pack). This proves the UI domain plugs into the frontend
// seams (DSL recognition + per-class static synthesis) without touching the generic core/compiler or
// the schema domain. @keyma/schema is a devDependency of @keyma/ui (test-only; NOT a runtime/publish
// dependency, so the package graph stays acyclic).
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
import type { KeymaIR, IRClassDeclaration } from "@keyma/core/ir";
import type { KeymaBackend, KeymaFrontend, KeymaTargetConfig, ResolvedConfig, EmitFile } from "@keyma/compiler";
import type { FrontendDomain } from "@keyma/compiler/frontend-ts";

import { schemaFrontendDomain } from "@keyma/schema/frontend-ts";
import { schemaIRValidator } from "@keyma/schema/ir";
import { schemaJsEmitterPack } from "@keyma/schema/backend-js";
import { schemaPythonEmitterPack } from "@keyma/schema/backend-python";
import { schemaCppEmitterPack } from "@keyma/schema/backend-cpp";

import { uiFrontendDomain } from "../src/frontend-ts/index.js";

// Register the schema-domain IR validator exactly as the CLI does, so validateIR runs the full
// envelope + schema-section checks against the UI-bearing document below.
defaultIRValidators.register(schemaIRValidator);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A directory under packages/ui from which both @keyma/schema/dsl and @keyma/ui/dsl resolve.
const BASE = path.join(__dirname, "..", "..", "src", "frontend-ts");

// Two files, one per domain: a @Schema class (non-UI) and a @UiView class side by side. Splitting
// them across modules lets the non-UI file be asserted byte-identical at file granularity (the
// @UiView class's module is the ONLY file the UI domain changes — by adding its `view` static).
const USER_SRC = `
import { Schema, Indexed } from "@keyma/schema/dsl";
@Schema({ name: "user" })
export class User {
    @Indexed({ unique: true }) declare id: string;
    declare email: string;
}
`;
const VIEW_SRC = `
import { UiView, Widget } from "@keyma/ui/dsl";
@UiView({ title: "Users", route: "/users" })
export class UserView {
    @Widget("text") declare name: string;
    @Widget("toggle") declare active: boolean;
}
`;

const config = { source: [], outDir: "dist", schemaPrefix: "", targets: [] } as unknown as ResolvedConfig;

function ir(domains: FrontendDomain[]): KeymaIR {
    return compileVirtual({ "user.ts": USER_SRC, "view.ts": VIEW_SRC }, { baseDir: BASE, domains }).ir;
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

/** The `view` static (if any) synthesized onto a class. */
function viewStatic(cls: IRClassDeclaration | undefined) {
    return (cls?.statics ?? []).find((s) => s.name === "view");
}

/**
 * Assert that adding the UI domain (a) emits exactly the same set of files (no new files, none
 * under `ui/`), (b) changes ONLY the `@UiView` class's module — every changed file names
 * "UserView" — and (c) leaves the non-UI (`User`) module byte-identical. Returns the changed
 * files' combined content for the caller to assert the `view` static shape against.
 */
function assertNonInterference(language: string, schemaOnly: EmitFile[], both: EmitFile[]): string {
    const base = byPath(schemaOnly);
    const combined = byPath(both);

    assert.deepEqual([...combined.keys()].sort(), [...base.keys()].sort(), `${language}: no files added or dropped`);
    assert.equal(
        [...combined.keys()].filter((p) => /(^|\/)ui\//.test(p)).length,
        0,
        `${language}: the UI domain no longer emits separate ui/ files`,
    );

    const changed = [...base.keys()].filter((p) => base.get(p) !== combined.get(p));
    assert.ok(changed.length > 0, `${language}: the @UiView class's output changed`);
    for (const p of changed) {
        assert.ok(combined.get(p)!.includes("UserView"), `${language}: only the UserView module changed — ${p} did not name it`);
    }

    // The non-UI User module is byte-identical (it names "User" but never "UserView").
    const userPath = [...base.keys()].find((p) => base.get(p)!.includes("User") && !base.get(p)!.includes("UserView"));
    assert.ok(userPath !== undefined, `${language}: the non-UI User module was found`);
    assert.equal(combined.get(userPath), base.get(userPath), `${language}: the non-UI User module is byte-identical`);

    return changed.map((p) => combined.get(p)!).join("\n");
}

describe("non-interference: domains ['schema','ui']", () => {
    const irSchemaOnly = ir([schemaFrontendDomain]);
    const irBoth = ir([schemaFrontendDomain, uiFrontendDomain]);

    it("leaves the non-UI class IR untouched and adds a `view` static to the @UiView class", () => {
        assert.equal(irSchemaOnly.extensions, undefined, "schema-only IR has no extensions");
        assert.equal(irBoth.extensions, undefined, "the UI domain writes no ir.extensions['ui']");
        assert.equal(irBoth.classes.length, irSchemaOnly.classes.length, "no classes added/removed");

        const userBoth = irBoth.classes.find((c) => c.sourceName === "User");
        const userOnly = irSchemaOnly.classes.find((c) => c.sourceName === "User");
        assert.deepEqual(userBoth, userOnly, "the non-UI User class is identical with/without the UI domain");

        // The @UiView class carries a `view` static only in the both-domains build.
        assert.equal(viewStatic(irSchemaOnly.classes.find((c) => c.sourceName === "UserView")), undefined);
        const view = viewStatic(irBoth.classes.find((c) => c.sourceName === "UserView"));
        assert.ok(view !== undefined, "UserView gained a `view` static");
        assert.deepEqual(view.type, { kind: "json" });
    });

    it("does not pollute the top-level schema/service arrays", () => {
        assert.equal(irBoth.classes.length, irSchemaOnly.classes.length);
        assert.equal(irBoth.services?.length ?? 0, irSchemaOnly.services?.length ?? 0);
    });

    it("JS: non-UI output byte-identical; @UiView class gains a structured `view` static", async () => {
        const schemaOnly = await emit(createJsBackend([schemaJsEmitterPack]), irSchemaOnly, "js");
        const both = await emit(createJsBackend([schemaJsEmitterPack]), irBoth, "js");
        const changed = assertNonInterference("js", schemaOnly, both);
        assert.match(changed, /UserView\.view = \{/, "JS emits the structured view object literal");
        assert.match(changed, /"field": "name", "kind": "text"/);
    });

    it("Python: non-UI output byte-identical; @UiView class gains a `view` dict static", async () => {
        const schemaOnly = await emit(createPythonBackend([schemaPythonEmitterPack]), irSchemaOnly, "python");
        const both = await emit(createPythonBackend([schemaPythonEmitterPack]), irBoth, "python");
        const changed = assertNonInterference("python", schemaOnly, both);
        assert.match(changed, /UserView\.view = \{/, "Python emits the view dict literal");
        assert.match(changed, /"field": "name", "kind": "text"/);
    });

    it("C++: non-UI output byte-identical; @UiView class gains a `view` JSON-string static", async () => {
        const schemaOnly = await emit(createCppBackend([schemaCppEmitterPack]), irSchemaOnly, "cpp");
        const both = await emit(createCppBackend([schemaCppEmitterPack]), irBoth, "cpp");
        const changed = assertNonInterference("cpp", schemaOnly, both);
        assert.match(changed, /static inline constexpr const char\* view = R"json\(/, "C++ emits the view as a JSON-string constant");
        assert.match(changed, /"name": "UserView"/);
    });

    it("a UI-bearing IR passes validateIR (envelope + schema-domain checks)", () => {
        const result = validateIR(irBoth as unknown as Record<string, unknown>);
        assert.equal(result.valid, true, `validation errors: ${JSON.stringify(result.errors)}`);
    });
});

// The full pipeline the CLI runs: frontend (both domains) → validateIR → backends → EmitFiles.
// This is the only test that exercises drive()/validateIR against a UI-bearing document end-to-end.
describe("end-to-end via drive() with both domains", () => {
    const frontend: KeymaFrontend = {
        name: "test",
        sourceExtensions: [".ts"],
        compile: async () => {
            const { ir, diagnostics } = compileVirtual(
                { "user.ts": USER_SRC, "view.ts": VIEW_SRC },
                { baseDir: BASE, domains: [schemaFrontendDomain, uiFrontendDomain] },
            );
            return { ir, diagnostics };
        },
    };
    // No UI backend pack: the UI domain is frontend-only now (its `view` static rides the class module).
    const backends: KeymaBackend[] = [
        createJsBackend([schemaJsEmitterPack]),
        createPythonBackend([schemaPythonEmitterPack]),
        createCppBackend([schemaCppEmitterPack]),
    ];
    const driveConfig = {
        source: [],
        outDir: "dist",
        schemaPrefix: "",
        targets: [target("js"), target("python"), target("cpp")],
    } as unknown as ResolvedConfig;

    it("drives cleanly and emits the `view` static into the class module — no separate ui/ files", async () => {
        const result = await drive(driveConfig, frontend, backends);
        assert.equal(result.hasErrors, false, `drive diagnostics: ${JSON.stringify(result.diagnostics)}`);

        const paths = result.emitted.map((f) => f.path);
        assert.ok(paths.some((p) => /src\/user\.(js|py|hpp)$/.test(p)), "schema models emitted");
        assert.ok(paths.some((p) => /src\/view\.(js|py|hpp)$/.test(p)), "the @UiView class's module emitted");
        assert.equal(paths.filter((p) => /(^|\/)ui\//.test(p)).length, 0, "no separate ui/ files");

        // The `view` static landed in the UserView module in every language.
        const viewFiles = result.emitted.filter((f) => (f.content as string).includes("UserView"));
        assert.ok(viewFiles.some((f) => /UserView\.view = \{/.test(f.content as string)), "JS/Python view static present");
        assert.ok(viewFiles.some((f) => /static inline constexpr const char\* view = R"json\(/.test(f.content as string)), "C++ view JSON-string static present");
    });
});

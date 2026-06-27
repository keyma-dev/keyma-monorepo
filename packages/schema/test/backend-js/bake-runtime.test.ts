// The opt-in validation API: the schema JS pack bakes the `validate` / `format` / `applyDefaults`
// drivers (+ their shared `schema-fields` walker) as bundle-local modules, so a generated app calls
// them off a class's `.metadata` with NO `@keyma/runtime` dependency. This test asserts the modules
// land in every bundle (client/server/library) AND that the BAKED copies actually run correctly
// against real emitted metadata (imported from the bundle dir, not from `@keyma/runtime`).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { KeymaIR, IRMember, IRType } from "@keyma/core/ir";
import type { ResolvedConfig, KeymaTargetConfig, EmitFile } from "@keyma/compiler";
import { emitJs } from "./harness.js";
import { minLengthDecl, trimDecl } from "../backend-cpp/fixtures.js";

const SRC = { file: "/proj/src/user.ts", line: 1, column: 1 };
type FExtra = Partial<IRMember> & {
    validators?: Array<{ name: string; params?: Record<string, unknown> }>;
    formatters?: Array<{ phase: string; spec: { name: string; params?: Record<string, unknown> } }>;
};
function f(name: string, type: IRType, extra: FExtra = {}): IRMember {
    const { validators, formatters, ...rest } = extra;
    const field: IRMember = { name, type, visibility: "public", readonly: false, required: true, source: SRC, ...rest };
    const schema: Record<string, unknown> = {};
    if (validators !== undefined) schema["validators"] = validators;
    if (formatters !== undefined) schema["formatters"] = formatters;
    if (Object.keys(schema).length > 0) (field as { extensions?: unknown }).extensions = { schema };
    return field;
}

// Flat, reference-free fixture so the emitted `user.js` imports as a plain module.
const IR: KeymaIR = {
    irVersion: "7.1.0", compilerVersion: "0.1.0", sourceRoot: "/proj/src",
    classes: [{
        name: "user", sourceName: "User", visibility: "public",
        fields: [
            f("id", { kind: "id" }, { readonly: true }),
            f("firstName", { kind: "string" }, {
                validators: [{ name: "minLength", params: { value: 2 } }],
                formatters: [{ phase: "change", spec: { name: "trim" } }, { phase: "save", spec: { name: "trim" } }],
            }),
            f("lastName", { kind: "string" }),
            f("role", { kind: "string" }, { default: { kind: "literal", value: "user" } }),
        ],
        source: SRC,
    }],
    functionDeclarations: [minLengthDecl, trimDecl],
    enums: [], diagnostics: [],
} as KeymaIR;

const CFG = {} as ResolvedConfig;
const TARGET = (extra: Partial<KeymaTargetConfig>): KeymaTargetConfig =>
    ({ language: "js", outDir: "out", ...extra } as KeymaTargetConfig);

const DRIVERS = ["schema-fields", "validate", "format", "defaults"];

function writeBundle(files: EmitFile[], dir: string): void {
    for (const file of files) {
        const p = join(dir, file.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, file.content);
    }
}

describe("schema JS pack bakes the opt-in validate/format/applyDefaults drivers", () => {
    it("emits each driver module (.js + .d.ts) into the client AND server bundles", async () => {
        const { files } = await emitJs(IR, TARGET({}), CFG);
        for (const bundle of ["client", "server"]) {
            for (const name of DRIVERS) {
                assert.ok(files.some((x) => x.path === `out/${bundle}/${name}.js`),
                    `missing out/${bundle}/${name}.js`);
                assert.ok(files.some((x) => x.path === `out/${bundle}/${name}.d.ts`),
                    `missing out/${bundle}/${name}.d.ts`);
            }
        }
    });

    it("baked validate.js imports only its sibling schema-fields.js (no @keyma/runtime)", async () => {
        const { files } = await emitJs(IR, TARGET({ library: true }), CFG);
        const validateJs = files.find((x) => x.path === "out/validate.js")!;
        const content = validateJs.content as string;
        assert.match(content, /from "\.\/schema-fields\.js"/);
        assert.doesNotMatch(content, /@keyma\/runtime/);
        // The factory reference lives in the model metadata, not in the generic driver.
        assert.doesNotMatch(content, /minLength/);
    });

    it("the BAKED drivers run correctly against real emitted metadata", async () => {
        const { files } = await emitJs(IR, TARGET({ library: true }), CFG);
        const dir = mkdtempSync(join(tmpdir(), "bake-js-"));
        try {
            writeBundle(files, dir);
            // Model metadata from the emitted bundle.
            const userFile = files.find((x) => /(^|\/)user\.js$/.test(x.path) && !x.path.endsWith(".d.ts"))!;
            const userMod = (await import(pathToFileURL(join(dir, userFile.path)).href)) as { User: { metadata: unknown } };
            const meta = userMod.User.metadata;
            // The BAKED drivers (bundle-local copies), NOT @keyma/runtime.
            const validateMod = (await import(pathToFileURL(join(dir, "out/validate.js")).href)) as {
                validate: (m: unknown, v: Record<string, unknown>) => Array<{ field: string; code: string }>;
            };
            const defaultsMod = (await import(pathToFileURL(join(dir, "out/defaults.js")).href)) as {
                applyDefaults: (m: unknown, d: Record<string, unknown>) => Record<string, unknown>;
            };
            const formatMod = (await import(pathToFileURL(join(dir, "out/format.js")).href)) as {
                format: (m: unknown, v: Record<string, unknown>, phase: string) => void;
            };

            // validate: "A" is too short (minLength); id/lastName/role are required+absent.
            const errs = validateMod.validate(meta, { firstName: "A" }).map((e) => e.code).sort();
            assert.deepEqual(errs, ["minLength", "required", "required", "required"]);

            // applyDefaults: role's literal default fills in.
            const d = defaultsMod.applyDefaults(meta, { firstName: "Ada", lastName: "Lovelace" });
            assert.equal(d["role"], "user");

            // format(save): firstName trimmed in place.
            const fr = { firstName: "  Ada  ", lastName: "Lovelace" };
            formatMod.format(meta, fr, "save");
            assert.equal(fr.firstName, "Ada");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

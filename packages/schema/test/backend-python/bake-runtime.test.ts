// The opt-in validation API (Python): the schema Python pack bakes the `validate` / `format` /
// `apply_defaults` drivers as a single self-contained `_keyma_schema.py`, so a generated app calls
// them off a class's `.metadata` dict with NO `keyma-runtime` dependency. This test asserts the
// module lands in every bundle (client/server) AND — when `python3` is available — that the BAKED
// copy actually runs correctly against real emitted metadata (imported from the bundle dir).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { KeymaIR, IRMember, IRType } from "@keyma/core/ir";
import type { ResolvedConfig, KeymaTargetConfig, EmitFile } from "@keyma/compiler";
import { emitPython } from "./harness.js";
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
    ({ language: "python", outDir: "out", ...extra } as KeymaTargetConfig);

function writeBundle(files: EmitFile[], dir: string): void {
    for (const file of files) {
        const p = join(dir, file.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, file.content);
    }
}

function detectPython3(): string | null {
    for (const py of [process.env["KEYMA_PYTHON"], "python3", "python"].filter(Boolean) as string[]) {
        try { execFileSync(py, ["--version"], { stdio: "ignore" }); return py; } catch { /* next */ }
    }
    return null;
}

describe("schema Python pack bakes the opt-in validate/format/apply_defaults drivers", () => {
    let python: string | null = null;
    before(() => { python = detectPython3(); });

    it("emits _keyma_schema.py into the client AND server bundles", async () => {
        const { files } = await emitPython(IR, TARGET({}), CFG);
        for (const bundle of ["client", "server"]) {
            assert.ok(files.some((x) => x.path === `out/${bundle}/_keyma_schema.py`),
                `missing out/${bundle}/_keyma_schema.py`);
        }
    });

    it("the baked module is self-contained (no keyma-runtime import)", async () => {
        const { files } = await emitPython(IR, TARGET({ library: true }), CFG);
        const mod = files.find((x) => x.path === "out/_keyma_schema.py")!;
        const content = mod.content as string;
        assert.doesNotMatch(content, /import\s+keyma/);
        assert.doesNotMatch(content, /from\s+keyma/);
        assert.match(content, /def validate\(/);
        assert.match(content, /def apply_defaults\(/);
    });

    it("the BAKED drivers run correctly against real emitted metadata", async (t) => {
        if (python === null) { t.skip("no python3 found (set KEYMA_PYTHON to enable)"); return; }
        const { files } = await emitPython(IR, TARGET({ library: true }), CFG);
        const dir = mkdtempSync(join(tmpdir(), "bake-py-"));
        try {
            writeBundle(files, dir);
            const out = join(dir, "out");
            const script = `
import sys, os, json, importlib
sys.path.insert(0, ${JSON.stringify(out)})
found = None
for base, _d, fnames in os.walk(${JSON.stringify(out)}):
    if 'user.py' in fnames:
        rel = os.path.relpath(os.path.join(base, 'user.py'), ${JSON.stringify(out)})
        found = rel[:-3].replace(os.sep, '.')
User = getattr(importlib.import_module(found), 'User')
# the BAKED drivers — NOT keyma.runtime
import _keyma_schema as ks
res = {}
res['validate'] = sorted(e['code'] for e in ks.validate(User.metadata, {'firstName': 'A'}))
d = ks.apply_defaults(User.metadata, {'firstName': 'Ada', 'lastName': 'Lovelace'}); res['role'] = d.get('role')
fr = {'firstName': '  Ada  ', 'lastName': 'Lovelace'}; ks.format(User.metadata, fr, 'save'); res['trimmed'] = fr['firstName']
print(json.dumps(res))
`;
            const r = JSON.parse(execFileSync(python, ["-c", script], { encoding: "utf-8" })) as {
                validate: string[]; role: string; trimmed: string;
            };
            assert.deepEqual(r.validate, ["minLength", "required", "required", "required"]);
            assert.equal(r.role, "user");
            assert.equal(r.trimmed, "Ada");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// Cross-language behavioral parity harness — the metadata-neutralization B-consistency gate.
//
// One shared fixture IR is emitted to JS, Python, and C++ (with the schema method synthesis applied,
// exactly as the compile pipeline's `afterNormalize` does). The synthesized instance methods +
// defaults-at-construction (the "B" world) are then run against the SAME emitted bundles over a
// shared corpus, in all three languages:
//   `Class.fromValue(rec).validate()`, `inst.formatSave()`, `Class.fromValue(rec)` (defaults filled
//   at hydration).
// Metadata is now PURE introspective data (no live validators/formatters/applyDefaults), so there is
// no independent runtime A oracle. JS-B is the reference, pinned to known ground-truth values
// (minLength error, trim, literal default applied); Python-B and C++-B are asserted == JS-B
// byte-identical. The languages must agree INDEPENDENTLY (JS-B is never edited to match the others).
//
// The JS-B reference always runs (in-process). The Python/C++ B legs are gated on `python3` / a C++23
// compiler and skip cleanly when absent. Run explicitly: npm -w @keyma/schema run test:parity
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { KeymaIR, IRMember, IRType } from "@keyma/core/ir";
import type { ResolvedConfig, KeymaTargetConfig } from "@keyma/compiler";
import { emitJs } from "../backend-js/harness.js";
import { emitPython } from "../backend-python/harness.js";
import { emitCpp } from "../backend-cpp/harness.js";
import { minLengthDecl, trimDecl } from "../backend-cpp/fixtures.js";

// ── Shared fixture: a flat, reference-free User. `firstName` carries a minLength validator + a
//    save-phase `trim` formatter; `role` is required WITH a literal default (filled at construction).
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

const PARITY_IR: KeymaIR = {
    irVersion: "7.1.0", compilerVersion: "0.1.0", sourceRoot: "/proj/src",
    classes: [{
        name: "user", sourceName: "User", visibility: "public",
        fields: [
            f("id", { kind: "id" }, { readonly: true }),
            f("firstName", { kind: "string" }, {
                validators: [{ name: "minLength", params: { value: 2 } }],
                formatters: [{ phase: "save", spec: { name: "trim" } }],
            }),
            f("lastName", { kind: "string" }),
            f("nickname", { kind: "string" }, { required: false }),
            f("role", { kind: "string" }, { default: { kind: "literal", value: "user" } }),
        ],
        source: SRC,
    }],
    functionDeclarations: [minLengthDecl, trimDecl],
    enums: [], diagnostics: [],
} as KeymaIR;

// ── Corpus. validate + format run over COMPLETE records (every required field present, so A's
//    required-presence checks never fire); defaults run over records that OMIT the defaulted `role`. ──
const COMPLETE: Record<string, Record<string, unknown>> = {
    valid: { id: "u1", firstName: "  Ada  ", lastName: "Lovelace", role: "admin" },
    short: { id: "u2", firstName: "A", lastName: "Turing", role: "member" },
};
const DEFAULTS: Record<string, Record<string, unknown>> = {
    needsRole: { id: "u3", firstName: "Ada", lastName: "Lovelace" }, // role absent → default "user"
    hasRole: { id: "u4", firstName: "Ada", lastName: "Lovelace", role: "admin" }, // role present → kept
};

type ParityResult = {
    validate: Record<string, Array<{ field: string; code: string }>>;
    format: Record<string, { firstName: unknown }>;
    defaults: Record<string, { role: unknown }>;
};

// Canonicalize for cross-world equality: sort object keys + sort each validate array.
function canon(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canon);
    if (v !== null && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v as object).sort()) out[k] = canon((v as Record<string, unknown>)[k]);
        return out;
    }
    return v;
}
function normalize(r: ParityResult): unknown {
    for (const name of Object.keys(r.validate)) {
        r.validate[name]!.sort((a, b) => `${a.field} ${a.code}`.localeCompare(`${b.field} ${b.code}`));
    }
    return canon(r);
}

const TARGET = (lang: string): KeymaTargetConfig => ({ language: lang, outDir: "out", library: true } as KeymaTargetConfig);
const CFG = {} as ResolvedConfig;

type EmitFileLike = { path: string; content: string | Uint8Array };

function writeBundle(files: EmitFileLike[], dir: string): void {
    for (const file of files) {
        const p = join(dir, file.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, file.content);
    }
}

// ── B (JS): the synthesized instance methods + defaults-at-construction, in-process. This is the
//    reference world — pinned below to known ground-truth values, and compared against by Python/C++. ──
async function runJsB(): Promise<ParityResult> {
    const { files } = await emitJs(PARITY_IR, TARGET("js"), CFG);
    const dir = mkdtempSync(join(tmpdir(), "parity-jsB-"));
    try {
        writeBundle(files, dir);
        const userFile = files.find((x) => /(^|\/)user\.js$/i.test(x.path) && !x.path.endsWith(".d.ts"))!;
        type U = { firstName: unknown; role: unknown; validate(): Array<{ field: string; code: string }>; formatSave(): void };
        const mod = (await import(pathToFileURL(join(dir, userFile.path)).href)) as { User: { fromValue(v: unknown): U } };
        const out: ParityResult = { validate: {}, format: {}, defaults: {} };
        for (const [name, rec] of Object.entries(COMPLETE)) {
            out.validate[name] = mod.User.fromValue({ ...rec }).validate().map((e) => ({ field: e.field, code: e.code }));
            const inst = mod.User.fromValue({ ...rec }); inst.formatSave(); out.format[name] = { firstName: inst.firstName };
        }
        for (const [name, rec] of Object.entries(DEFAULTS)) {
            out.defaults[name] = { role: mod.User.fromValue({ ...rec }).role };
        }
        return out;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ── B (Python): same, driven by `python3`. ──
function runPythonB(files: EmitFileLike[], python: string, runtimeSrc: string): ParityResult {
    const dir = mkdtempSync(join(tmpdir(), "parity-pyB-"));
    try {
        writeBundle(files, dir);
        const out = join(dir, "out");
        const script = `
import sys, json, os, importlib
sys.path.insert(0, ${JSON.stringify(out)})
sys.path.insert(0, ${JSON.stringify(runtimeSrc)})
found = None
for base, _d, fnames in os.walk(${JSON.stringify(out)}):
    if 'user.py' in fnames:
        rel = os.path.relpath(os.path.join(base, 'user.py'), ${JSON.stringify(out)})
        found = rel[:-3].replace(os.sep, '.')
User = getattr(importlib.import_module(found), 'User')
complete = json.loads(${JSON.stringify(JSON.stringify(COMPLETE))})
defaults = json.loads(${JSON.stringify(JSON.stringify(DEFAULTS))})
res = {"validate": {}, "format": {}, "defaults": {}}
for name, rec in complete.items():
    res["validate"][name] = [{"field": e["field"], "code": e["code"]} for e in User.from_value(dict(rec)).validate()]
    inst = User.from_value(dict(rec)); inst.formatSave(); res["format"][name] = {"firstName": inst.firstName}
for name, rec in defaults.items():
    res["defaults"][name] = {"role": User.from_value(dict(rec)).role}
print(json.dumps(res))
`;
        return JSON.parse(execFileSync(python, ["-c", script], { encoding: "utf-8" })) as ParityResult;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ── B (C++): emit, generate a main.cpp that constructs instances + calls the synthesized methods. ──
function runCppB(files: EmitFileLike[], cxx: string, runtimeInc: string): ParityResult {
    const dir = mkdtempSync(join(tmpdir(), "parity-cppB-"));
    try {
        writeBundle(files, dir);
        const root = join(dir, "out");
        const completeBlocks = Object.entries(COMPLETE).map(([name, rec]) => {
            const j = JSON.stringify(JSON.stringify(rec)); const n = JSON.stringify(name);
            return `    { app::User u = app::User::from_value(json_parse(${j}, a), a); vsec.set(${n}, errs_json(u.validate(), a)); }
    { app::User u = app::User::from_value(json_parse(${j}, a), a); u.formatSave(); Value o = Value::object(a); o.set("firstName", Value(std::string_view(u.firstName), a)); fsec.set(${n}, std::move(o)); }`;
        }).join("\n");
        const defaultBlocks = Object.entries(DEFAULTS).map(([name, rec]) => {
            const j = JSON.stringify(JSON.stringify(rec)); const n = JSON.stringify(name);
            return `    { app::User u = app::User::from_value(json_parse(${j}, a), a); Value o = Value::object(a); o.set("role", Value(std::string_view(u.role), a)); dsec.set(${n}, std::move(o)); }`;
        }).join("\n");
        const main = `#include "index.hpp"
#include <keyma/json.hpp>
#include <iostream>
#include <string_view>
using namespace keyma;
static Value errs_json(const std::pmr::vector<ValidationError>& errs, alloc_t a) {
    Value arr = Value::array(a);
    for (const auto& e : errs) {
        Value o = Value::object(a);
        o.set("field", Value(std::string_view(e.field), a));
        o.set("code", Value(std::string_view(e.code), a));
        arr.push(std::move(o));
    }
    return arr;
}
int main() {
    std::pmr::monotonic_buffer_resource pool; alloc_t a{&pool};
    Value vsec = Value::object(a), fsec = Value::object(a), dsec = Value::object(a);
${completeBlocks}
${defaultBlocks}
    Value res = Value::object(a);
    res.set("validate", std::move(vsec));
    res.set("format", std::move(fsec));
    res.set("defaults", std::move(dsec));
    std::cout << json_stringify(res, a);
    return 0;
}`;
        writeFileSync(join(dir, "main.cpp"), main);
        const exe = join(dir, "parity.test");
        execFileSync(cxx, ["-std=c++23", "-I", root, "-I", runtimeInc, join(dir, "main.cpp"), "-o", exe], { stdio: ["ignore", "ignore", "pipe"] });
        return JSON.parse(execFileSync(exe, [], { encoding: "utf-8" })) as ParityResult;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function detectCxx23(): string | null {
    const probe = `#include <memory_resource>
#include <expected>
#include <format>
#include <chrono>
int main() {
    std::expected<void, int> e{};
    std::pmr::string s{"x"};
    auto t = std::format("{}", 1);
    std::chrono::sys_days d{std::chrono::year{2020}/1/1};
    return (e ? 0 : 1) + (int)s.size() + (int)t.size() + (int)d.time_since_epoch().count() * 0;
}`;
    const candidates = [process.env["KEYMA_CXX"], "g++-15", "g++-14", "g++-13", "clang++-18", "clang++-17", "g++", "clang++", "c++"].filter(Boolean) as string[];
    for (const cc of candidates) {
        try {
            execFileSync(cc, ["-std=c++23", "-x", "c++", "-fsyntax-only", "-"], { input: probe, stdio: ["pipe", "ignore", "ignore"] });
            return cc;
        } catch { /* try next */ }
    }
    return null;
}

function detectPython3(): string | null {
    for (const py of [process.env["KEYMA_PYTHON"], "python3", "python"].filter(Boolean) as string[]) {
        try {
            execFileSync(py, ["--version"], { stdio: "ignore" });
            return py;
        } catch { /* try next */ }
    }
    return null;
}

const RUNTIME_CPP_INC = join(process.cwd(), "..", "runtime-cpp", "include");
const RUNTIME_PY_SRC = join(process.cwd(), "..", "runtime-python", "src");

describe("cross-language parity — B (synthesized methods) consistency (JS-B reference)", () => {
    let reference: ParityResult;
    let cxx: string | null = null;
    let python: string | null = null;

    before(async () => {
        reference = await runJsB();
        cxx = detectCxx23();
        python = detectPython3();
    });

    it("JS-B is a meaningful baseline (minLength error, trim, literal default applied)", () => {
        assert.deepEqual(reference.validate["valid"], []);
        assert.deepEqual(reference.validate["short"], [{ field: "firstName", code: "minLength" }]);
        assert.equal(reference.format["valid"]!.firstName, "Ada");
        assert.equal(reference.defaults["needsRole"]!.role, "user");
        assert.equal(reference.defaults["hasRole"]!.role, "admin");
    });

    it("Python B == JS-B", async (t) => {
        if (python === null) { t.skip("no python3 found (set KEYMA_PYTHON to enable)"); return; }
        const { files } = await emitPython(PARITY_IR, TARGET("python"), CFG);
        assert.deepEqual(normalize(runPythonB(files, python, RUNTIME_PY_SRC)), normalize(reference));
    });

    it("C++ B == JS-B", async (t) => {
        if (cxx === null) { t.skip("no C++23 compiler found (set KEYMA_CXX to enable)"); return; }
        const { files } = await emitCpp(PARITY_IR, TARGET("cpp"), CFG);
        assert.deepEqual(normalize(runCppB(files, cxx, RUNTIME_CPP_INC)), normalize(reference));
    });
});

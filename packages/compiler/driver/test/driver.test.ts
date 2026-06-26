import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KeymaIR, IRDiagnostic } from "@keyma/core/ir";
import {
    loadConfig,
    resolveConfig,
    drive,
    type KeymaFrontend,
    type KeymaBackend,
    type ResolvedConfig,
} from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.join(__dirname, "..", "..", "..", "driver", "test", "fixtures");

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function emptyIR(): KeymaIR {
    return { irVersion: "1.0.0", compilerVersion: "0.1.0", schemas: [], diagnostics: [] };
}

function mockFrontend(overrides?: Partial<{
    ir: KeymaIR;
    diagnostics: IRDiagnostic[];
}>): KeymaFrontend {
    return {
        name: "mock",
        sourceExtensions: [".ts"],
        async compile(_config: ResolvedConfig) {
            return {
                ir: overrides?.ir ?? emptyIR(),
                diagnostics: overrides?.diagnostics ?? [],
            };
        },
    };
}

function mockBackend(target: string, files: string[] = []): KeymaBackend {
    return {
        name: `mock-${target}`,
        target,
        async emit(_ir, _targetConfig, _config) {
            return {
                files: files.map((p) => ({ path: p, content: "" })),
                diagnostics: [],
            };
        },
    };
}

// ─── resolveConfig ───────────────────────────────────────────────────────────

describe("resolveConfig", () => {
    it("applies default outDir when omitted", () => {
        const resolved = resolveConfig({});
        assert.equal(resolved.outDir, "dist");
    });

    it("normalises string source to array", () => {
        const resolved = resolveConfig({ source: "src/**/*.ts" });
        assert.deepEqual(resolved.source, ["src/**/*.ts"]);
    });

    it("preserves array source as-is", () => {
        const resolved = resolveConfig({ source: ["a.ts", "b.ts"] });
        assert.deepEqual(resolved.source, ["a.ts", "b.ts"]);
    });

    it("defaults to empty array for targets", () => {
        const resolved = resolveConfig({});
        assert.deepEqual(resolved.targets, []);
    });

    it("passes irOutFile through when present", () => {
        const resolved = resolveConfig({ irOutFile: ".keyma/schema.ir.json" });
        assert.equal(resolved.irOutFile, ".keyma/schema.ir.json");
    });

    it("omits irOutFile when not provided", () => {
        const resolved = resolveConfig({});
        assert.equal("irOutFile" in resolved, false);
    });
});

// ─── loadConfig ───────────────────────────────────────────────────────────────

describe("loadConfig", () => {
    it("loads a JSON config file", async () => {
        const config = await loadConfig(path.join(FIXTURES, "test-config.json"));
        assert.deepEqual(config.source, ["src/**/*.ts"]);
        assert.equal(config.outDir, "dist");
        assert.deepEqual(config.targets, []);
    });

    it("loads a .mjs config file via dynamic import", async () => {
        const config = await loadConfig(path.join(FIXTURES, "test-config.mjs"));
        assert.deepEqual(config.source, ["src/**/*.ts"]);
        assert.equal(config.outDir, "build");
        assert.equal(config.targets?.length, 1);
        assert.equal(config.targets?.[0]?.language, "js");
    });

    it("throws a descriptive error for .ts config files", async () => {
        await assert.rejects(
            () => loadConfig(path.join(FIXTURES, "nonexistent.ts")),
            /TypeScript config files must be compiled/
        );
    });

    it("throws a descriptive error for unknown extensions", async () => {
        await assert.rejects(
            () => loadConfig(path.join(FIXTURES, "config.yaml")),
            /Unsupported config file extension/
        );
    });
});

// ─── drive ────────────────────────────────────────────────────────────────────

describe("drive — basic orchestration", () => {
    it("returns ir from the frontend", async () => {
        const ir = emptyIR();
        const result = await drive(resolveConfig({}), mockFrontend({ ir }), []);
        assert.equal(result.ir, ir);
    });

    it("returns hasErrors: false for a clean run", async () => {
        const result = await drive(resolveConfig({}), mockFrontend(), []);
        assert.equal(result.hasErrors, false);
    });

    it("aggregates frontend diagnostics", async () => {
        const diag: IRDiagnostic = { code: "KEYMA001", severity: "error", message: "dup" };
        const result = await drive(resolveConfig({}), mockFrontend({ diagnostics: [diag] }), []);
        assert.ok(result.diagnostics.includes(diag));
    });

    it("returns hasErrors: true when frontend emits an error", async () => {
        const diag: IRDiagnostic = { code: "KEYMA001", severity: "error", message: "dup" };
        const result = await drive(resolveConfig({}), mockFrontend({ diagnostics: [diag] }), []);
        assert.equal(result.hasErrors, true);
    });

    it("returns empty emitted array when there are no targets", async () => {
        const result = await drive(resolveConfig({}), mockFrontend(), []);
        assert.deepEqual(result.emitted, []);
    });
});

describe("drive — backend orchestration", () => {
    it("calls a matching backend and collects its files", async () => {
        const config = resolveConfig({ targets: [{ language: "js", outDir: "dist/js" }] });
        const backend = mockBackend("js", ["dist/js/index.js"]);
        const result = await drive(config, mockFrontend(), [backend]);
        assert.ok(result.emitted.some((f) => f.path === "dist/js/index.js"));
        assert.equal(result.hasErrors, false);
    });

    it("emits an error diagnostic when no backend is found for a target", async () => {
        const config = resolveConfig({ targets: [{ language: "cpp", outDir: "dist/cpp" }] });
        const result = await drive(config, mockFrontend(), []);
        assert.equal(result.hasErrors, true);
        assert.ok(
            result.diagnostics.some((d) => d.message.includes("cpp")),
            `Expected error mentioning "cpp". Got: ${JSON.stringify(result.diagnostics)}`
        );
    });

    it("does not run backends when frontend emits errors", async () => {
        const config = resolveConfig({ targets: [{ language: "js", outDir: "dist/js" }] });
        let backendCalled = false;
        const backend: KeymaBackend = {
            name: "spy",
            target: "js",
            async emit() {
                backendCalled = true;
                return { files: [], diagnostics: [] };
            },
        };
        const errDiag: IRDiagnostic = { code: "KEYMA001", severity: "error", message: "err" };
        await drive(config, mockFrontend({ diagnostics: [errDiag] }), [backend]);
        assert.equal(backendCalled, false, "Backend should not be called when there are errors");
    });

    it("runs multiple backends and concatenates emitted files", async () => {
        const config = resolveConfig({
            targets: [
                { language: "js", outDir: "dist/js" },
                { language: "cpp", outDir: "dist/cpp" },
            ],
        });
        const jsBackend = mockBackend("js", ["dist/js/index.js"]);
        const cppBackend = mockBackend("cpp", ["dist/cpp/schema.hpp"]);
        const result = await drive(config, mockFrontend(), [jsBackend, cppBackend]);
        assert.ok(result.emitted.some((f) => f.path === "dist/js/index.js"));
        assert.ok(result.emitted.some((f) => f.path === "dist/cpp/schema.hpp"));
        assert.equal(result.hasErrors, false);
    });
});

describe("drive — IR validation", () => {
    it("catches structurally invalid IR from the frontend", async () => {
        const badIR = { irVersion: 123, schemas: "not-an-array" } as unknown as KeymaIR;
        const result = await drive(resolveConfig({}), mockFrontend({ ir: badIR }), []);
        assert.equal(result.hasErrors, true);
        assert.ok(
            result.diagnostics.some((d) => d.message.includes("IR validation")),
            `Expected IR validation error. Got: ${JSON.stringify(result.diagnostics)}`
        );
    });
});

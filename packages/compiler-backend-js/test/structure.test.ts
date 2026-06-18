import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { KeymaIR } from "@keyma/ir";
import { emitJs } from "../src/backend.js";
import type { JsTargetConfig } from "../src/types.js";

const ROOT = process.platform === "win32" ? "C:\\project" : "/project";
const SRC_DIR = path.join(ROOT, "src");

const NESTED_IR: KeymaIR = {
    irVersion: "1.0.0",
    compilerVersion: "0.1.0",
    sourceRoot: SRC_DIR,
    schemas: [
        {
            id: "schema:user",
            name: "user",
            sourceName: "User",
            visibility: "public",
            fields: [
                {
                    name: "profile",
                    type: { kind: "reference", schema: "Profile" },
                    visibility: "public",
                    readonly: false,
                    required: true,
                    validators: [],
                    formatters: [],
                    indexes: [],
                    source: { file: path.join(SRC_DIR, "auth", "User.ts"), line: 5, column: 5 }
                }
            ],
            indexes: [],
            source: { file: path.join(SRC_DIR, "auth", "User.ts"), line: 1, column: 1 }
        },
        {
            id: "schema:profile",
            name: "profile",
            sourceName: "Profile",
            visibility: "public",
            fields: [],
            indexes: [],
            source: { file: path.join(SRC_DIR, "core", "Profile.ts"), line: 1, column: 1 }
        }
    ],
    diagnostics: [],
};

const target: JsTargetConfig = {
    language: "js",
    outDir: "dist",
    library: true
};

const config = {
    source: [],
    outDir: "dist",
    targets: [target]
};

describe("JS Backend Structure", () => {
    it("should preserve folder structure for models", async () => {
        const { files } = await emitJs(NESTED_IR, target, config);
        
        const filePaths = files.map(f => f.path);
        
        assert.ok(filePaths.includes("dist/models/auth/user.js"), "Should have auth/user.js");
        assert.ok(filePaths.includes("dist/models/core/profile.js"), "Should have core/profile.js");
        
        const userJs = files.find(f => f.path === "dist/models/auth/user.js")!.content as string;
        // The import path should always use forward slashes.
        assert.ok(userJs.includes('import { Profile } from "../core/profile.js"'), "Should have relative import to profile");
        
        const indexJs = files.find(f => f.path === "dist/index.js")!.content as string;
        assert.ok(indexJs.includes('export { User } from "./models/auth/user.js"'), "Index should export User from auth/user.js");
        assert.ok(indexJs.includes('export { Profile } from "./models/core/profile.js"'), "Index should export Profile from core/profile.js");
    });
});

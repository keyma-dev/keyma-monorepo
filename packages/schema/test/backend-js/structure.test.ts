import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { KeymaIR } from "@keyma/core/ir";
import { emitJs } from "./harness.js";
import type { JsTargetConfig } from "@keyma/compiler/backend-js";

const ROOT = process.platform === "win32" ? "C:\\project" : "/project";
const SRC_DIR = path.join(ROOT, "src");

const NESTED_IR: KeymaIR = {
    irVersion: "1.0.0",
    compilerVersion: "0.1.0",
    sourceRoot: SRC_DIR,
    classes: [
        {
            name: "user",
            sourceName: "User",
            visibility: "public",
            fields: [
                {
                    name: "profile",
                    type: { kind: "reference", schema: "profile" },
                    visibility: "public",
                    readonly: false,
                    required: true,
                    source: { file: path.join(SRC_DIR, "auth", "User.ts"), line: 5, column: 5 }
                }
            ],
            source: { file: path.join(SRC_DIR, "auth", "User.ts"), line: 1, column: 1 }
        },
        {
            name: "profile",
            sourceName: "Profile",
            visibility: "public",
            fields: [],
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
    schemaPrefix: "",
    targets: [target]
};

describe("JS Backend Structure", () => {
    it("should preserve folder structure for models", async () => {
        const { files } = await emitJs(NESTED_IR, target, config);
        
        const filePaths = files.map(f => f.path);
        
        // Output file names mirror the SOURCE file stems (User.ts → User.js), faithfully
        // replicating the source structure — not the schema name (which fixed the case bug).
        assert.ok(filePaths.includes("dist/models/auth/User.js"), "Should have auth/User.js");
        assert.ok(filePaths.includes("dist/models/core/Profile.js"), "Should have core/Profile.js");

        const userJs = files.find(f => f.path === "dist/models/auth/User.js")!.content as string;
        // The import path should always use forward slashes.
        assert.ok(userJs.includes('import { Profile } from "../core/Profile.js"'), "Should have relative import to profile");

        const indexJs = files.find(f => f.path === "dist/index.js")!.content as string;
        assert.ok(indexJs.includes('export { User } from "./models/auth/User.js"'), "Index should export User from auth/User.js");
        assert.ok(indexJs.includes('export { Profile } from "./models/core/Profile.js"'), "Index should export Profile from core/Profile.js");
    });
});

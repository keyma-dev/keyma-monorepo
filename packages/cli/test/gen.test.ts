import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runNew } from "../src/commands/new.js";
import { runGen } from "../src/commands/gen.js";
import { runBuild } from "../src/commands/build.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_ROOT = join(__dirname, "..", "..", ".tmp-gen");

describe("keyma gen", () => {
    let projectDir: string;

    before(() => {
        rmSync(TMP_ROOT, { recursive: true, force: true });
        mkdirSync(TMP_ROOT, { recursive: true });
        projectDir = mkdtempSync(join(TMP_ROOT, "proj-"));
    });

    after(() => {
        rmSync(TMP_ROOT, { recursive: true, force: true });
    });

    it("produces a schema file the compiler accepts", async () => {
        const dir = join(projectDir, "app");
        runNew({ name: "app", dir });

        const { path } = runGen({ name: "user", cwd: dir });
        assert.ok(existsSync(path));
        const content = readFileSync(path, "utf-8");
        assert.match(content, /@Schema/);
        assert.match(content, /class User\b/);

        const result = await runBuild({ cwd: dir });
        const errorDiagnostics = result.diagnostics.filter((d) => d.severity === "error");
        assert.equal(
            errorDiagnostics.length,
            0,
            `unexpected errors: ${JSON.stringify(errorDiagnostics)}`
        );
        assert.equal(result.hasErrors, false);
        assert.equal(result.ir.classes.length, 1);
        assert.equal(result.ir.classes[0]?.name, "user");

        // The JS backend writes both client and server bundles by default.
        const expectedFiles = [
            "dist/js/client/src/user.js",
            "dist/js/server/src/user.js",
            "dist/js/client/index.js",
            "dist/js/server/index.js",
        ];
        for (const rel of expectedFiles) {
            assert.ok(existsSync(join(dir, rel)), `expected ${rel} to be emitted`);
        }
    });

    it("refuses to overwrite an existing file without --force", () => {
        const dir = join(projectDir, "app2");
        runNew({ name: "app2", dir });
        runGen({ name: "post", cwd: dir });
        assert.throws(() => runGen({ name: "post", cwd: dir }), /already exists/);
    });

    it("can generate a schema in a subfolder", async () => {
        const dir = join(projectDir, "app-sub");
        runNew({ name: "app-sub", dir });

        const { path } = runGen({ name: "auth/user", cwd: dir });

        const expectedSubPath = join("src", "auth", "user.ts");
        assert.ok(path.endsWith(expectedSubPath), `Expected path ${path} to end with ${expectedSubPath}`);
        assert.ok(existsSync(path), `File ${path} should exist`);

        const content = readFileSync(path, "utf-8");
        assert.match(content, /@Schema\({ name: "auth-user" }\)/);
        assert.match(content, /export class AuthUser/);
    });
});

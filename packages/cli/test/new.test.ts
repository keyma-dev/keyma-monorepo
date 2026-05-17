import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runNew } from "../src/commands/new.js";
import { runBuild } from "../src/commands/build.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Live inside the repo so npm workspace resolution finds @keyma/dsl when the
// scaffolded project's TypeScript imports it.
const TMP_ROOT = join(__dirname, "..", "..", ".tmp");

describe("keyma new", () => {
    let projectDir: string;

    before(() => {
        rmSync(TMP_ROOT, { recursive: true, force: true });
        mkdirSync(TMP_ROOT, { recursive: true });
        projectDir = mkdtempSync(join(TMP_ROOT, "new-"));
    });

    after(() => {
        rmSync(TMP_ROOT, { recursive: true, force: true });
    });

    it("scaffolds the expected file tree", () => {
        const dir = join(projectDir, "my-app");
        const { files } = runNew({ name: "my-app", dir });

        const expected = [
            "package.json",
            "tsconfig.json",
            "keyma.config.ts",
            "src/index.ts",
            "src/schemas/.gitkeep",
        ];
        for (const rel of expected) {
            assert.ok(existsSync(join(dir, rel)), `expected ${rel} to exist`);
        }
        assert.equal(files.length, expected.length);

        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
            name: string;
            scripts: Record<string, string>;
            dependencies: Record<string, string>;
        };
        assert.equal(pkg.name, "my-app");
        assert.equal(pkg.scripts["build"], "keyma build");
        assert.ok(pkg.dependencies["@keyma/dsl"], "should depend on @keyma/dsl");
    });

    it("scaffolded project builds successfully (empty schemas)", async () => {
        const dir = join(projectDir, "buildable");
        runNew({ name: "buildable", dir });

        const result = await runBuild({ cwd: dir });
        assert.equal(result.hasErrors, false, `unexpected errors: ${JSON.stringify(result.diagnostics)}`);
        // Empty schema set produces no emitted files but no errors either.
        assert.equal(result.diagnostics.length, 0);
    });

    it("refuses to scaffold into a non-empty directory without --force", () => {
        assert.throws(
            () => runNew({ name: "x", dir: projectDir }),
            /non-empty directory/
        );
    });
});


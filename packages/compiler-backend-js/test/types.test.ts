import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { KeymaIR } from "@keyma/ir";
import { emitJs } from "../src/backend.js";
import { emitTypesDts } from "../src/emit-types.js";
import type { JsTargetConfig } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_TYPES = path.resolve(__dirname, "../../../runtime-js/src/types.ts");

const loc = { file: "/p/src/user.ts", line: 1, column: 1 };
const IR: KeymaIR = {
    irVersion: "3.1.0",
    compilerVersion: "0.1.0",
    sourceRoot: "/p/src",
    schemas: [
        {
            id: "schema:user",
            name: "user",
            sourceName: "User",
            visibility: "public",
            fields: [
                {
                    name: "id",
                    type: { kind: "id" },
                    visibility: "public",
                    readonly: true,
                    required: true,
                    validators: [],
                    formatters: [],
                    indexes: [],
                    source: loc,
                },
            ],
            indexes: [],
            source: loc,
        },
    ],
    diagnostics: [],
};
const target: JsTargetConfig = { language: "js", outDir: "dist" };
const config = { source: [], outDir: "dist", targets: [target] };

describe("inlined dependency-free types", () => {
    it("emitTypesDts is a verbatim copy of @keyma/runtime-js types.ts (drift guard)", () => {
        const source = readFileSync(RUNTIME_TYPES, "utf8");
        assert.ok(
            emitTypesDts().includes(source),
            "emitted types.d.ts is stale — run `npm run -w @keyma/compiler-backend-js gen-types`",
        );
    });

    it("declares the core type surface and contains no imports", () => {
        const dts = emitTypesDts();
        for (const t of ["SchemaMetadata", "ValidatorFn", "FormatterFn", "ServiceMetadata", "RequestContext", "ValidationError"]) {
            assert.ok(
                dts.includes(`export type ${t}`) || dts.includes(`export interface ${t}`),
                `missing ${t}`,
            );
        }
        assert.ok(!dts.includes("import "), "inlined types must not import anything");
    });

    it("every bundle emits types.{js,d.ts}; models import from it; no @keyma imports remain", async () => {
        const { files } = await emitJs(IR, target, config);
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes("dist/client/types.js") && paths.includes("dist/client/types.d.ts"));
        assert.ok(paths.includes("dist/server/types.js") && paths.includes("dist/server/types.d.ts"));

        const model = files.find((f) => f.path === "dist/client/models/user.d.ts")!.content as string;
        assert.ok(model.includes('from "../types.js"'), "model should import its types locally");

        // No generated file may import from a @keyma/* package (comments are fine).
        for (const f of files) {
            const c = typeof f.content === "string" ? f.content : "";
            assert.ok(!/from "@keyma\//.test(c), `${f.path} still imports from @keyma/*`);
        }
    });
});

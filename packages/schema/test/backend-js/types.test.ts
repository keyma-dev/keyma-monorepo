import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KeymaIR } from "@keyma/core/ir";
import { emitJs } from "./harness.js";
import { emitTypesDts } from "@keyma/compiler/backend-js";
import type { JsTargetConfig } from "@keyma/compiler/backend-js";

const loc = { file: "/p/src/user.ts", line: 1, column: 1 };
const IR: KeymaIR = {
    irVersion: "3.1.0",
    compilerVersion: "0.1.0",
    sourceRoot: "/p/src",
    classes: [
        {
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
                    source: loc,
                },
            ],
            source: loc,
        },
    ],
    diagnostics: [],
};
const target: JsTargetConfig = { language: "js", outDir: "dist" };
const config = { source: [], outDir: "dist", namePrefix: "", targets: [target] };

// The runtime `types.ts` is no longer copied verbatim: the compiler now owns ONLY the
// service/request surface (`emitTypesDts([])`), while the data-model metadata surface
// (`ClassMetadata`, `ValidatorFn`, …) is sliced + renamed out of the runtime source by the
// schema pack and contributed via its `runtimeTypeDecls()` hook. A full bundle's emitted
// `types.d.ts` is the concatenation of the two. These tests guard that split (and the new
// contract names) instead of a verbatim-against-runtime-source equality.

const SERVICE_SURFACE = [
    "ServiceMetadata", "ServiceMethodMetadata", "ServiceParamMetadata",
    "ServiceClass", "ServiceProvider", "ServiceInstance", "RequestContext",
];
const SCHEMA_SURFACE = [
    "ClassMetadata", "ValidatorFn", "FormatterFn", "FormatterEntry",
    "FieldMetadata", "EdgeMetadata", "ClassBrand", "ValidationError",
    "FieldType", "ClassDefaultsFn", "ClassIndex", "RecordOf",
];

function declares(dts: string, name: string): boolean {
    return dts.includes(`export type ${name}`) || dts.includes(`export interface ${name}`);
}

describe("inlined dependency-free types", () => {
    it("the compiler base blob declares the service/request surface ONLY (no schema metadata) and imports nothing", () => {
        const base = emitTypesDts([]);
        for (const t of SERVICE_SURFACE) {
            assert.ok(declares(base, t), `compiler base blob missing service decl ${t}`);
        }
        // The schema metadata surface is contributed by the schema pack, not the base blob.
        // (`ClassBrand` is *referenced* by `ServiceMetadata.refs` but not declared here, so we
        //  guard on the truly-absent declarations.)
        for (const t of ["ClassMetadata", "SchemaMetadata", "ValidatorFn", "FormatterFn", "FieldMetadata"]) {
            assert.ok(!declares(base, t), `schema metadata decl ${t} must NOT be in the compiler base blob`);
        }
        assert.ok(!base.includes("import "), "inlined types must not import anything");
    });

    it("a full bundle's emitted types.d.ts carries BOTH blobs under the new contract names", async () => {
        const { files } = await emitJs(IR, target, config);
        const dts = files.find((f) => f.path === "dist/client/types.d.ts")!.content as string;

        for (const t of [...SERVICE_SURFACE, ...SCHEMA_SURFACE]) {
            assert.ok(declares(dts, t), `bundle types.d.ts missing declaration ${t}`);
        }
        // The pre-rename names must be fully gone from the emitted surface.
        for (const old of ["SchemaMetadata", "SchemaClass", "SchemaDefaultsFn", "SchemaIndex"]) {
            assert.ok(!dts.includes(old), `stale pre-rename type ${old} leaked into the bundle types.d.ts`);
        }
        assert.ok(!dts.includes("import "), "inlined bundle types must not import anything");
    });

    it("every bundle emits types.{js,d.ts}; models import from it; no @keyma imports remain", async () => {
        const { files } = await emitJs(IR, target, config);
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes("dist/client/types.js") && paths.includes("dist/client/types.d.ts"));
        assert.ok(paths.includes("dist/server/types.js") && paths.includes("dist/server/types.d.ts"));

        const model = files.find((f) => f.path === "dist/client/src/user.d.ts")!.content as string;
        assert.ok(model.includes('from "../types.js"'), "model should import its types locally");

        // No generated file may import from a @keyma/* package (comments are fine).
        for (const f of files) {
            const c = typeof f.content === "string" ? f.content : "";
            assert.ok(!/from "@keyma\//.test(c), `${f.path} still imports from @keyma/*`);
        }
    });
});

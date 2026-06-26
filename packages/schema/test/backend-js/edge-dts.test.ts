// Guards the edge `.d.ts` shaping that the schema pack contributes via the generic JS
// backend's `shapeSchemaDts` hook (residual #2: the shaping used to live in the generic
// `@keyma/compiler/backend-js/emit-module.ts`). An edge class is privatized to `_X` and the
// public binding `X` is re-exported as a branded const carrying the `__edge` phantom. No
// other test emits an edge schema's `.d.ts`, so this is the byte-identity guard for that path.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KeymaIR } from "@keyma/core/ir";
import type { KeymaTargetConfig, ResolvedConfig } from "@keyma/compiler";
import { emitJs } from "./harness.js";

const S = (file: string) => ({ file, line: 1, column: 1 });
const refField = (name: string, schema: string) => ({
    name, type: { kind: "reference" as const, schema },
    visibility: "public" as const, readonly: false, required: true,
    validators: [], formatters: [], source: S("knows.ts"),
});

const EDGE_IR: KeymaIR = {
    irVersion: "1.0.0", compilerVersion: "0.1.0",
    schemas: [
        {
            id: "s:person", name: "person", sourceName: "Person", visibility: "public",
            fields: [{ name: "id", type: { kind: "id" }, visibility: "public", readonly: true, required: true, validators: [], formatters: [], source: S("person.ts") }],
            source: S("person.ts"),
        },
        {
            id: "s:knows", name: "knows", sourceName: "Knows", visibility: "public",
            fields: [refField("a", "person"), refField("b", "person")],
            extensions: { schema: { edge: { from: "person", fromField: "a", to: "person", toField: "b", label: "knows", directed: true } } },
            source: S("knows.ts"),
        },
    ],
    diagnostics: [],
};

const LIBRARY_TARGET = { language: "js", outDir: "dist", library: true } as unknown as KeymaTargetConfig;
const CONFIG = { source: [], outDir: "dist", schemaPrefix: "", targets: [] } as unknown as ResolvedConfig;

const EXPECTED_KNOWS_DTS = `import type { SchemaMetadata } from "../types.js";
import type { Person } from "./person.js";

declare class _Knows {
    static readonly schema: SchemaMetadata;
    a: Person;
    b: Person;
    constructor(value?: { a?: Person; b?: Person });
}

export declare const Knows: typeof _Knows & { readonly __edge?: { from: Person; to: Person } };
export type Knows = InstanceType<typeof _Knows>;
`;

describe("emitJs — edge .d.ts shaping (schema pack shapeSchemaDts hook)", () => {
    it("privatizes the edge class and re-exports a branded const with the __edge phantom", async () => {
        const { files } = await emitJs(EDGE_IR, LIBRARY_TARGET, CONFIG);
        const dts = files.find((x) => x.path === "dist/models/knows.d.ts");
        assert.ok(dts !== undefined, "edge model .d.ts was emitted");
        assert.equal(dts.content, EXPECTED_KNOWS_DTS);
    });

    it("a plain (non-edge) schema keeps the default `export declare class`", async () => {
        const { files } = await emitJs(EDGE_IR, LIBRARY_TARGET, CONFIG);
        const personDts = files.find((x) => x.path === "dist/models/person.d.ts");
        assert.ok(personDts !== undefined);
        assert.ok((personDts.content as string).includes("export declare class Person {"), "plain schema unchanged");
        assert.ok(!(personDts.content as string).includes("__edge"), "no edge phantom on a plain schema");
    });
});

// Guards the edge class `.d.ts` emission. The `__edge` phantom brand + `_X` privatization were
// DROPPED (Step 4 / T-edge): an edge class now emits as a plain `export declare class`, exactly
// like any other class. Edge SEMANTICS survive in `<Class>.metadata.edge` (untouched by this).
// The endpoint type (`Person`) is still imported via the class's `a`/`b` reference fields. No
// other test emits an edge schema's `.d.ts`, so this is the byte-identity guard for that path.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KeymaIR } from "@keyma/core/ir";
import type { KeymaTargetConfig, ResolvedConfig } from "@keyma/compiler";
import { emitJs } from "./harness.js";

const S = (file: string) => ({ file, line: 1, column: 1 });
const refField = (name: string, schema: string) => ({
    name, type: { kind: "reference" as const, target: schema },
    visibility: "public" as const, readonly: false, required: true,
    validators: [], formatters: [], source: S("knows.ts"),
});

const EDGE_IR: KeymaIR = {
    irVersion: "1.0.0", compilerVersion: "0.1.0",
    classes: [
        {
            name: "person", sourceName: "Person", visibility: "public",
            fields: [{ name: "id", type: { kind: "id" }, visibility: "public", readonly: true, required: true, source: S("person.ts") }],
            source: S("person.ts"),
        },
        {
            name: "knows", sourceName: "Knows", visibility: "public",
            fields: [refField("a", "person"), refField("b", "person")],
            extensions: { schema: { edge: { from: "person", fromField: "a", to: "person", toField: "b", label: "knows", directed: true } } },
            source: S("knows.ts"),
        },
    ],
    diagnostics: [],
};

const LIBRARY_TARGET = { language: "js", outDir: "dist", library: true } as unknown as KeymaTargetConfig;
const CONFIG = { source: [], outDir: "dist", namePrefix: "", targets: [] } as unknown as ResolvedConfig;

const EXPECTED_KNOWS_DTS = `import type { ClassMetadata } from "../types.js";
import type { Person } from "./person.js";

export declare class Knows {
    static readonly metadata: ClassMetadata;
    a: Person;
    b: Person;
    static fromValue(value?: { a?: Person; b?: Person }): Knows;
}
`;

describe("emitJs — edge .d.ts emission (no phantom brand)", () => {
    it("emits an edge class as a plain `export declare class` (no __edge brand, no privatization)", async () => {
        const { files } = await emitJs(EDGE_IR, LIBRARY_TARGET, CONFIG);
        const dts = files.find((x) => x.path === "dist/src/knows.d.ts");
        assert.ok(dts !== undefined, "edge model .d.ts was emitted");
        assert.equal(dts.content, EXPECTED_KNOWS_DTS);
    });

    it("a plain (non-edge) schema keeps the default `export declare class`", async () => {
        const { files } = await emitJs(EDGE_IR, LIBRARY_TARGET, CONFIG);
        const personDts = files.find((x) => x.path === "dist/src/person.d.ts");
        assert.ok(personDts !== undefined);
        assert.ok((personDts.content as string).includes("export declare class Person {"), "plain schema unchanged");
        assert.ok(!(personDts.content as string).includes("__edge"), "no edge phantom on a plain schema");
    });
});

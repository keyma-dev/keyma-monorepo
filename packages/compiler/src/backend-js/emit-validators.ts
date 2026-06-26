import type { IRFunctionDeclaration } from "@keyma/core/ir";
import { stmtToJs } from "./emit-expression.js";
import { irTypeToTs } from "./ir-type-to-ts.js";

/** Sanitize a name to a JS binding identifier (e.g. for a referenced factory import). */
export function factoryIdent(name: string): string {
    return name.replace(/-/g, "_");
}

// ─── Utility functions (functions.js) ──────────────────────────────────────────
//
// The generic project-local function emitter. After the validator→function collapse this
// emits every function the bundle keeps in `functions.js` — plain utility helpers. The
// validator/formatter factories (also `IRFunctionDeclaration`s) are CLAIMED by the schema
// domain pack, which emits them with the runtime `ValidatorFn`/`FormatterFn` wrapper, so the
// generic backend excludes their names from this set.

export type FunctionEmitFiles = { functionsJs: string; functionsDts: string };

/** Emit compiled project-local utility functions as an ES module + types. */
export function emitFunctionFiles(
    declarations: readonly IRFunctionDeclaration[],
    embeddedNames?: ReadonlyMap<string, string>,
): FunctionEmitFiles {
    const js: string[] = [];
    const dts: string[] = [];
    for (const decl of declarations) {
        const params = decl.params.map((p) => p.name).join(", ");
        const body = decl.statements.map((s) => stmtToJs(s, "    ")).join("\n");
        js.push(`export function ${decl.name}(${params}) {\n${body}\n}`);

        const dtsParams = decl.params.map((p) => `${p.name}: ${irTypeToTs(p.type, embeddedNames)}`).join(", ");
        dts.push(`export declare function ${decl.name}(${dtsParams}): ${irTypeToTs(decl.returnType, embeddedNames)};`);
    }
    return { functionsJs: js.join("\n\n") + "\n", functionsDts: dts.join("\n") + "\n" };
}

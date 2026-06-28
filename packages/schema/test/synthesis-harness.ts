// Shared test helper: apply the schema domain's method synthesis to a hand-built IR, mirroring what
// the frontend's `afterNormalize` hook does in the real compile pipeline. The backend tests + the
// parity harness build IR by hand (bypassing the frontend), so without this they would emit classes
// WITHOUT the synthesized `validate()`/`format*()` methods — which both carry the validator/formatter
// logic (B) and drive the factory imports/tree-shaking through the IR call graph. Returns a new IR
// (the input is left untouched); a class with no validators/formatters is returned unchanged.
import type { KeymaIR, IRFunctionDeclaration } from "@keyma/core/ir";
import { synthesizeClassMembers } from "../src/frontend-ts/synthesize.js";

export function withSchemaSynthesis(ir: KeymaIR): KeymaIR {
    const functionDecls = new Map<string, IRFunctionDeclaration>((ir.functionDeclarations ?? []).map((d) => [d.name, d]));
    const classesBySourceName = new Map(ir.classes.map((c) => [c.sourceName, c]));
    const classes = ir.classes.map((cls) => {
        const { methods } = synthesizeClassMembers(cls, { functionDecls, classesBySourceName });
        return methods.length > 0 ? { ...cls, methods: [...(cls.methods ?? []), ...methods] } : cls;
    });
    return { ...ir, classes };
}

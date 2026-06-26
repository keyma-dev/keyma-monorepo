import { path } from "@keyma/core/util";
import type { KeymaIR } from "@keyma/core/ir";
import type { EmitFile } from "@keyma/compiler";
import type { PythonEmitterPack } from "@keyma/compiler/backend-python";
import { buildSchemaData } from "./schema-data.js";
import { emitValidatorsPy, emitFormattersPy } from "./emit-validators.js";
import { fieldValidators, fieldFormatters } from "../ir/extensions.js";

/**
 * The schema-domain Python emitter pack: supplies the per-schema `<Class>.schema` metadata
 * builder and — since the validator→function collapse — the validator/formatter factory
 * modules. The CLI registers it into the generic Python backend's `EmitterRegistry`;
 * `@keyma/compiler` references no schema symbol. (Python omits services/enums by design.)
 */
export const schemaPythonEmitterPack: PythonEmitterPack = {
    name: "schema",
    buildSchemaData,
    // Validator/formatter factory functions are emitted here (with the runtime wrapper), so the
    // generic backend excludes them from functions.py.
    claimFunctions: (ir) => {
        const { validatorNames, formatterNames } = factoryNames(ir);
        const claimed = new Set<string>(validatorNames);
        for (const n of formatterNames) claimed.add(n);
        return claimed;
    },
    emitBundleFiles: (ir, ctx): EmitFile[] => {
        const fns = ir.functionDeclarations ?? [];
        const { validatorNames, formatterNames } = factoryNames(ir);
        const validatorFns = fns.filter((d) => validatorNames.has(d.name));
        const formatterFns = fns.filter((d) => formatterNames.has(d.name));
        if (validatorFns.length === 0 && formatterFns.length === 0) return [];

        // Utility functions (everything not claimed) live in functions.py; validators/formatters
        // import them via `from .functions import *` when present.
        const hasFunctions = fns.some((d) => !validatorNames.has(d.name) && !formatterNames.has(d.name));

        const files: EmitFile[] = [];
        if (validatorFns.length > 0) {
            files.push({ path: path.posix.join(ctx.bundleDir, "validators.py"), content: emitValidatorsPy(validatorFns, hasFunctions) });
        }
        if (formatterFns.length > 0) {
            files.push({ path: path.posix.join(ctx.bundleDir, "formatters.py"), content: emitFormattersPy(formatterFns, hasFunctions) });
        }
        return files;
    },
};

/** Validator/formatter factory names referenced by any field's `@Validate`/`@Format`. */
function factoryNames(ir: KeymaIR): { validatorNames: ReadonlySet<string>; formatterNames: ReadonlySet<string> } {
    const validatorNames = new Set<string>();
    const formatterNames = new Set<string>();
    for (const cls of ir.classes) {
        for (const field of cls.fields) {
            for (const v of fieldValidators(field)) validatorNames.add(v.name);
            for (const f of fieldFormatters(field)) formatterNames.add(f.spec.name);
        }
    }
    return { validatorNames, formatterNames };
}

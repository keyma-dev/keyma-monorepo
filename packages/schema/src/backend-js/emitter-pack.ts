import { path } from "@keyma/core/util";
import type { KeymaIR } from "@keyma/core/ir";
import type { EmitFile } from "@keyma/compiler";
import type { JsEmitterPack } from "@keyma/compiler/backend-js";
import { buildSchemaData } from "./schema-data.js";
import { shapeSchemaDts } from "./schema-dts.js";
import { emitServicesJs, emitServicesDts } from "./emit-service.js";
import { emitValidatorsJs, emitValidatorsDts, emitFormattersJs, emitFormattersDts } from "./emit-validators.js";
import { fieldValidators, fieldFormatters } from "../ir/extensions.js";

/**
 * The schema-domain JS emitter pack: supplies the per-schema `<Class>.schema` metadata
 * builder, the edge `.d.ts` shaping, the bundle-root services file, and — since the
 * validator→function collapse — the validator/formatter factory modules. The CLI registers it
 * into the generic JS backend's `EmitterRegistry`; `@keyma/compiler` references no schema symbol.
 */
export const schemaJsEmitterPack: JsEmitterPack = {
    name: "schema",
    buildSchemaData,
    shapeSchemaDts,
    emitServices: (services, deps) => ({
        js: emitServicesJs(services, deps),
        dts: emitServicesDts(services, deps),
    }),
    // Validator/formatter factory functions are emitted here (with the runtime wrapper), so the
    // generic backend excludes them from functions.js.
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

        // Utility functions (everything not claimed) live in functions.js; validators import
        // them from there.
        const utilityNames = fns
            .filter((d) => !validatorNames.has(d.name) && !formatterNames.has(d.name))
            .map((d) => d.name);

        const files: EmitFile[] = [];
        if (validatorFns.length > 0) {
            files.push({ path: path.posix.join(ctx.bundleDir, "validators.js"), content: emitValidatorsJs(validatorFns, utilityNames) });
            files.push({ path: path.posix.join(ctx.bundleDir, "validators.d.ts"), content: emitValidatorsDts(validatorFns) });
        }
        if (formatterFns.length > 0) {
            files.push({ path: path.posix.join(ctx.bundleDir, "formatters.js"), content: emitFormattersJs(formatterFns, utilityNames) });
            files.push({ path: path.posix.join(ctx.bundleDir, "formatters.d.ts"), content: emitFormattersDts(formatterFns) });
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

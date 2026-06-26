import { path } from "@keyma/core/util";
import type { KeymaIR } from "@keyma/core/ir";
import type { EmitFile } from "@keyma/compiler";
import type { CppEmitterPack } from "@keyma/compiler/backend-cpp";
import { buildSchemaMeta } from "./schema-data.js";
import { emitEnumClass, emitEnumConversions } from "./emit-enum.js";
import { emitServicesCpp } from "./emit-service.js";
import { emitServiceClientCpp } from "./emit-service-client.js";
import { emitValidatorsCpp, emitFormattersCpp } from "./emit-validators.js";
import { fieldValidators, fieldFormatters } from "../ir/extensions.js";

/**
 * The schema-domain C++ emitter pack: supplies the per-schema `schema()` metadata body, the
 * enum `class` + keyma conversions, the service / service-client headers, and — since the
 * validator→function collapse — the validator/formatter factory headers. The CLI registers it
 * into the generic C++ backend's `EmitterRegistry`; `@keyma/compiler` references no schema symbol.
 */
export const schemaCppEmitterPack: CppEmitterPack = {
    name: "schema",
    buildSchemaMeta,
    emitEnumClass,
    emitEnumConversions,
    emitServices: emitServicesCpp,
    emitServiceClient: emitServiceClientCpp,
    // Validator/formatter factory functions are emitted here (with the runtime wrapper), so the
    // generic backend excludes them from functions.hpp.
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

        // Utility functions (everything not claimed) live in functions.hpp; the validator/formatter
        // headers `#include` it + `using namespace …::functions;` when any exist.
        const hasFunctions = fns.some((d) => !validatorNames.has(d.name) && !formatterNames.has(d.name));

        const files: EmitFile[] = [];
        if (validatorFns.length > 0) {
            files.push({ path: path.posix.join(ctx.bundleDir, "validators.hpp"), content: emitValidatorsCpp(validatorFns, hasFunctions, ctx.nsRoot, ctx.runtimeInclude) });
        }
        if (formatterFns.length > 0) {
            files.push({ path: path.posix.join(ctx.bundleDir, "formatters.hpp"), content: emitFormattersCpp(formatterFns, hasFunctions, ctx.nsRoot, ctx.runtimeInclude) });
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

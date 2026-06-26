import type { PythonEmitterPack } from "@keyma/compiler/backend-python";
import { buildSchemaData } from "./schema-data.js";
import { factoryNames, renderClaimedFunctions } from "./emit-validators.js";

/**
 * The schema-domain Python emitter pack: supplies the per-schema `<Class>.schema` metadata
 * builder and — since the validator→function collapse — the validator/formatter factory wrapper
 * rendering. The CLI registers it into the generic Python backend's `EmitterRegistry`;
 * `@keyma/compiler` references no schema symbol. Validator/formatter factories are claimed here
 * and rendered (with the runtime guard wrapper) co-located in their source module by the generic
 * module emitter. (Python omits services/enums by design.)
 */
export const schemaPythonEmitterPack: PythonEmitterPack = {
    name: "schema",
    buildSchemaData,
    claimFunctions: (ir) => {
        const { validatorNames, formatterNames } = factoryNames(ir);
        const claimed = new Set<string>(validatorNames);
        for (const n of formatterNames) claimed.add(n);
        return claimed;
    },
    renderClaimedFunctions,
};

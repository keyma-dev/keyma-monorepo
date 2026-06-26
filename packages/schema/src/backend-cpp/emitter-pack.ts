import type { CppEmitterPack } from "@keyma/compiler/backend-cpp";
import { buildSchemaData } from "./schema-data.js";
import { emitServicesCpp } from "./emit-service.js";
import { emitServiceClientCpp } from "./emit-service-client.js";
import { factoryNames, renderClaimedFunctions } from "./emit-validators.js";

/**
 * The schema-domain C++ emitter pack: supplies the per-schema `schema()` metadata (as neutral
 * data the compiler renders), the service / service-client headers, and — since the
 * validator→function collapse — the validator/formatter factory wrapper rendering. The CLI
 * registers it into the generic C++ backend's `EmitterRegistry`; `@keyma/compiler` references no
 * schema symbol. Named-enum emission is now fully compiler-owned. Validator/formatter factories
 * are claimed here and rendered (with the runtime guard wrapper) into their own source module by
 * the generic module emitter.
 */
export const schemaCppEmitterPack: CppEmitterPack = {
    name: "schema",
    buildSchemaData,
    emitServices: emitServicesCpp,
    emitServiceClient: emitServiceClientCpp,
    claimFunctions: (ir) => {
        const { validatorNames, formatterNames } = factoryNames(ir);
        const claimed = new Set<string>(validatorNames);
        for (const n of formatterNames) claimed.add(n);
        return claimed;
    },
    renderClaimedFunctions,
};

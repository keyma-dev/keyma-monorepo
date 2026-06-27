import type { JsEmitterPack } from "@keyma/compiler/backend-js";
import { buildSchemaData } from "./schema-data.js";
import { shapeSchemaDts } from "./schema-dts.js";
import { factoryNames, renderClaimedFunctions } from "./emit-validators.js";

/**
 * The schema-domain JS emitter pack: supplies the per-schema `<Class>.schema` metadata
 * builder, the edge `.d.ts` shaping, and — since the validator→function collapse — the
 * validator/formatter factory wrapper rendering. The CLI registers it into the generic JS
 * backend's `EmitterRegistry`; `@keyma/compiler` references no schema symbol. (`@Service`
 * emission is compiler-owned: the bundle shell emits the services file directly.) Validator/
 * formatter factories are claimed here and rendered (with the runtime guard wrapper) into their
 * own source module by the generic module emitter.
 */
export const schemaJsEmitterPack: JsEmitterPack = {
    name: "schema",
    buildSchemaData,
    shapeSchemaDts,
    claimFunctions: (ir) => {
        const { validatorNames, formatterNames } = factoryNames(ir);
        const claimed = new Set<string>(validatorNames);
        for (const n of formatterNames) claimed.add(n);
        return claimed;
    },
    renderClaimedFunctions,
};

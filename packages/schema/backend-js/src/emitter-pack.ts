import type { JsEmitterPack } from "@keyma/compiler/backend-js";
import { buildSchemaData } from "./schema-data.js";
import { shapeSchemaDts } from "./schema-dts.js";
import { emitServicesJs, emitServicesDts } from "./emit-service.js";

/**
 * The schema-domain JS emitter pack: supplies the per-schema `<Class>.schema` metadata
 * builder, the edge `.d.ts` shaping, and the bundle-root services file. The CLI registers it
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
};

import type { CppEmitterPack } from "@keyma/compiler/backend-cpp";
import { buildSchemaMeta } from "./schema-data.js";
import { emitEnumClass, emitEnumConversions } from "./emit-enum.js";
import { emitServicesCpp } from "./emit-service.js";
import { emitServiceClientCpp } from "./emit-service-client.js";

/**
 * The schema-domain C++ emitter pack: supplies the per-schema `schema()` metadata body, the
 * enum `class` + keyma conversions, and the service / service-client headers. The CLI registers
 * it into the generic C++ backend's `EmitterRegistry`; `@keyma/compiler` references no schema symbol.
 */
export const schemaCppEmitterPack: CppEmitterPack = {
    name: "schema",
    buildSchemaMeta,
    emitEnumClass,
    emitEnumConversions,
    emitServices: emitServicesCpp,
    emitServiceClient: emitServiceClientCpp,
};

import type { PythonEmitterPack } from "@keyma/compiler/backend-python";
import { buildSchemaData } from "./schema-data.js";

/**
 * The schema-domain Python emitter pack: supplies the per-schema `<Class>.schema` metadata
 * builder. The CLI registers it into the generic Python backend's `EmitterRegistry`;
 * `@keyma/compiler` references no schema symbol. (Python omits services/enums by design.)
 */
export const schemaPythonEmitterPack: PythonEmitterPack = {
    name: "schema",
    buildSchemaData,
};

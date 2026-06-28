import type { PythonEmitterPack } from "@keyma/compiler/backend-python";
import { buildClassData } from "./schema-data.js";

/**
 * The schema-domain Python emitter pack: supplies the per-class `<Class>.metadata` builder. The
 * validator/formatter factories are ORDINARY functions emitted by the generic backend (no
 * claimed-wrapper rendering): the synthesized `validate()`/`format*()` methods reference them
 * through the IR call graph (tree-shaken generically). The CLI registers this pack into the generic
 * Python backend's `EmitterRegistry`; `@keyma/compiler` references no schema symbol. (Python omits
 * services/enums by design.)
 */
export const schemaPythonEmitterPack: PythonEmitterPack = {
    name: "schema",
    buildClassData,
};

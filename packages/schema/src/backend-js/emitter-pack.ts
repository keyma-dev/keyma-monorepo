import type { JsEmitterPack } from "@keyma/compiler/backend-js";
import { buildClassMetadata as buildClassData } from "../metadata-descriptor.js";
import { shapeClassDts } from "./schema-dts.js";
import { EMITTED_SCHEMA_TYPES_DTS } from "./emitted-runtime-types.js";

/**
 * The schema-domain JS emitter pack: supplies the per-class `<Class>.metadata` builder, the edge
 * `.d.ts` shaping, and the `ClassMetadata` runtime type surface. The validator/formatter factories
 * are ORDINARY functions emitted by the generic backend (no claimed-wrapper rendering): the
 * synthesized `validate()`/`format*()` methods reference them through the IR call graph (tree-shaken
 * generically). The CLI registers this pack into the generic JS backend's `EmitterRegistry`;
 * `@keyma/compiler` references no schema symbol. (`@Service` emission is compiler-owned.)
 */
export const schemaJsEmitterPack: JsEmitterPack = {
    name: "schema",
    buildClassData,
    shapeClassDts,
    runtimeTypeDecls: () => EMITTED_SCHEMA_TYPES_DTS,
};

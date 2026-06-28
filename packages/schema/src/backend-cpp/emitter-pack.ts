import type { CppEmitterPack } from "@keyma/compiler/backend-cpp";
import { buildClassData } from "./schema-data.js";

/**
 * The schema-domain C++ emitter pack: supplies the per-class `metadata()` data (as neutral data
 * the compiler renders). The validator/formatter factories are now ORDINARY functions emitted by
 * the generic backend as concretely-typed generic lambdas (no claimed-wrapper rendering): the
 * synthesized `validate()`/`format*()` methods reference them through the IR call graph (resolved
 * via per-module using-directives, tree-shaken generically). The CLI registers this pack into the
 * generic C++ backend's `EmitterRegistry`; `@keyma/compiler` references no schema symbol.
 * (`@Service` + named-enum emission are compiler-owned.)
 */
export const schemaCppEmitterPack: CppEmitterPack = {
    name: "schema",
    buildClassData,
};

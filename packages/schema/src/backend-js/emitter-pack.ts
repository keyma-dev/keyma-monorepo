import { path } from "@keyma/core/util";
import type { EmitFile } from "@keyma/compiler";
import type { JsEmitterPack } from "@keyma/compiler/backend-js";
import { buildClassData } from "./schema-data.js";
import { shapeClassDts } from "./schema-dts.js";
import { EMITTED_SCHEMA_TYPES_DTS } from "./emitted-runtime-types.js";
import { EMITTED_SCHEMA_RUNTIME_MODULES } from "./emitted-schema-runtime.js";

/**
 * The schema-domain JS emitter pack: supplies the per-class `<Class>.metadata` builder, the edge
 * `.d.ts` shaping, and the `ClassMetadata` runtime type surface. The validator/formatter factories
 * are now ORDINARY functions emitted by the generic backend (no claimed-wrapper rendering): the
 * synthesized `validate()`/`format*()` methods reference them through the IR call graph (tree-shaken
 * generically), and `<Class>.metadata` calls the same live callable for the A runtime driver
 * (plan §2.4). The CLI registers this pack into the generic JS backend's `EmitterRegistry`;
 * `@keyma/compiler` references no schema symbol. (`@Service` emission is compiler-owned.)
 */
export const schemaJsEmitterPack: JsEmitterPack = {
    name: "schema",
    buildClassData,
    shapeClassDts,
    runtimeTypeDecls: () => EMITTED_SCHEMA_TYPES_DTS,
    /**
     * The opt-in validation API: the `validate` / `format` / `applyDefaults` drivers (+ their
     * shared `schema-fields` field walker), baked verbatim from `@keyma/runtime` as bundle-local
     * modules. An app imports them from the bundle (`./validate.js`, …) and calls them against a
     * generated class's `.metadata` — no `@keyma/runtime` dependency. The drivers are generic over
     * the metadata, so the same modules serve every bundle: the client bundle's metadata already
     * carries only its form-phase formatters and public fields (decision: validate + form-phase
     * format are usable client-side), and lacks server-only defaults, so `applyDefaults` is inert
     * there. Emitted for every registered build (it never inspects the IR), like the codec/RPC
     * modules the compiler bakes.
     */
    emitBundleFiles: (_ir, ctx): EmitFile[] => {
        const files: EmitFile[] = [];
        for (const [name, mod] of Object.entries(EMITTED_SCHEMA_RUNTIME_MODULES)) {
            files.push({ path: path.posix.join(ctx.bundleDir, `${name}.js`), content: mod.js });
            files.push({ path: path.posix.join(ctx.bundleDir, `${name}.d.ts`), content: mod.dts });
        }
        return files;
    },
};

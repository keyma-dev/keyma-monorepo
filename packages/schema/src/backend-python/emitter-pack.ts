import { path } from "@keyma/core/util";
import type { EmitFile } from "@keyma/compiler";
import type { PythonEmitterPack } from "@keyma/compiler/backend-python";
import { buildClassData } from "./schema-data.js";
import { EMITTED_PY_SCHEMA_RUNTIME, EMITTED_PY_SCHEMA_RUNTIME_MODULE } from "./emitted-schema-runtime.js";

/**
 * The schema-domain Python emitter pack: supplies the per-class `<Class>.metadata` builder. The
 * validator/formatter factories are now ORDINARY functions emitted by the generic backend (no
 * claimed-wrapper rendering): the synthesized `validate()`/`format*()` methods reference them
 * through the IR call graph (tree-shaken generically), and `<Class>.metadata` calls the same live
 * callable for the A runtime driver (plan §2.4). The CLI registers this pack into the generic
 * Python backend's `EmitterRegistry`; `@keyma/compiler` references no schema symbol. (Python omits
 * services/enums by design.)
 */
export const schemaPythonEmitterPack: PythonEmitterPack = {
    name: "schema",
    buildClassData,
    /**
     * The opt-in validation API: the `validate` / `format` / `apply_defaults` drivers (+ their
     * shared `schema_fields` walker + `_context` invoker), baked verbatim from `@keyma/runtime`
     * (the Python runtime) into a single self-contained `_keyma_schema.py`. A generated app imports
     * them from there and calls them off a class's `.metadata` dict — no `keyma-runtime` dependency.
     * The drivers are generic over the metadata, so the same module serves every bundle (the client
     * bundle's metadata already carries only its form-phase formatters + public fields, and lacks
     * server-only defaults, so `apply_defaults` is inert there). Emitted for every build, like the
     * codec/RPC `_keyma_rpc.py` the compiler bakes.
     */
    emitBundleFiles(_ir, ctx): EmitFile[] {
        return [{
            path: path.posix.join(ctx.bundleDir, `${EMITTED_PY_SCHEMA_RUNTIME_MODULE}.py`),
            content: EMITTED_PY_SCHEMA_RUNTIME,
        }];
    },
};

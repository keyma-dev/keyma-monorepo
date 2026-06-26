import type { IRDocumentValidator } from "@keyma/core/ir";
import type { FrontendDomain } from "../../frontend-ts/src/index.js";
import type { JsEmitterPack } from "../../backend-js/src/index.js";
import type { PythonEmitterPack } from "../../backend-python/src/index.js";
import type { CppEmitterPack } from "../../backend-cpp/src/index.js";

/**
 * A domain's backend emitter packs, keyed by target language. A domain may contribute to
 * any subset of the languages (the schema domain contributes all three; a future domain
 * might cover only some). Each pack is the per-language contribution consumed by the
 * matching `create{Js,Python,Cpp}Backend(packs)` factory.
 */
export type KeymaDomainEmitterPacks = {
    js?: JsEmitterPack;
    python?: PythonEmitterPack;
    cpp?: CppEmitterPack;
};

/**
 * The single descriptor a domain package (`@keyma/schema` today, `@keyma/ui` next) exports
 * from its **package root** as `keymaDomain`. It bundles the domain's contribution to every
 * extension seam so a host (the CLI) can load one well-known export and wire all four seams
 * without naming any domain-specific symbol:
 *
 *  - `frontend`     → registered on the frontend's `FrontendExtensionRegistry`
 *  - `irValidator`  → registered on the IR `IRValidatorRegistry` (`defaultIRValidators`)
 *  - `emitterPacks` → fed to the per-language backend factories
 *
 * `@keyma/compiler` stays domain-neutral: it only defines this contract (and the seams),
 * never a concrete domain. The type lives here — the package every domain already depends
 * on — via type-only imports of the seam types, so no runtime edge is introduced.
 */
export interface KeymaDomain {
    /** Stable short identifier, e.g. `"schema"` or `"ui"`. Used in diagnostics/logging. */
    name: string;
    /** The frontend extraction domain whose `produce()` contributes its IR sections. */
    frontend: FrontendDomain;
    /** Optional IR section validator, registered onto the driver's validator registry. */
    irValidator?: IRDocumentValidator;
    /** Per-language backend emitter packs (any language may be omitted). */
    emitterPacks: KeymaDomainEmitterPacks;
}

import type { IRDocumentValidator, IntrinsicDef } from "@keyma/core/ir";
import type { FrontendDomain } from "../frontend-ts/index.js";
import type { JsEmitterPack } from "../backend-js/index.js";
import type { PythonEmitterPack } from "../backend-python/index.js";
import type { CppEmitterPack } from "../backend-cpp/index.js";

/**
 * A domain's backend emitter packs, keyed by target language. A domain may contribute to
 * any subset of the languages (one domain might contribute all three; another might cover
 * only some). Each pack is the per-language contribution consumed by the matching
 * `create{Js,Python,Cpp}Backend(packs)` factory.
 */
export type KeymaDomainEmitterPacks = {
    js?: JsEmitterPack;
    python?: PythonEmitterPack;
    cpp?: CppEmitterPack;
};

/**
 * The single descriptor a domain package exports from its **package root** as `keymaDomain`.
 * It bundles the domain's contribution to every extension seam so a host (the CLI) can load
 * one well-known export and wire all four seams without naming any domain-specific symbol:
 *
 *  - `frontend`     → registered on the frontend's `FrontendExtensionRegistry`
 *  - `irValidator`  → registered on the IR `IRValidatorRegistry` (`defaultIRValidators`)
 *  - `emitterPacks` → fed to the per-language backend factories
 *
 * `@keyma/compiler` stays domain-neutral: it only defines this contract (and the seams),
 * never a concrete domain. The type lives here — the package every domain already depends
 * on — via type-only imports of the seam types, so no runtime dependency is introduced.
 */
export interface KeymaDomain {
    /** Stable short identifier, e.g. `"ui"`. Used in diagnostics/logging. */
    name: string;
    /** The frontend domain — its decorators + per-class/program hooks enrich the compiler-built
     *  IR (the compiler owns the driver; the domain contributes only its slice). */
    frontend: FrontendDomain;
    /** Optional IR section validator, registered onto the driver's validator registry. */
    irValidator?: IRDocumentValidator;
    /** Per-language backend emitter packs (any language may be omitted). */
    emitterPacks: KeymaDomainEmitterPacks;
    /**
     * New primitive ops this domain contributes to the intrinsic registry — recognition (so the
     * frontend lowers them to `{kind:"intrinsic"}`) **and** per-language native-snippet emission.
     * Merged with the core registry by the host (the CLI registers them onto `defaultIntrinsics`).
     * Per-language emitters are optional; a configured target missing an emitter for an op a body
     * uses is caught by the driver's pre-emit compatibility scan. Omit when the domain adds no
     * new primitives — the structural shapes (methods, function values, metadata) need none. */
    intrinsics?: IntrinsicDef[];
    /**
     * The target languages this domain supports (backend `target` ids — `"js"`/`"python"`/`"cpp"`).
     * When set, every configured build target must appear here or the build fails fast with a
     * config error (a domain that cannot emit for a requested language is a misconfiguration, not
     * a silent partial emit). Omit to impose no constraint (the domain supports every target). */
    targets?: string[];
}

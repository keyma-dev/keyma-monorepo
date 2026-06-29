import type { IRDocumentValidator, IntrinsicDef } from "@keyma/core/ir";
import type { FrontendDomain } from "../frontend-ts/index.js";
import type { BuildClassData } from "./class-metadata.js";
import type { RuntimeSymbols, RecordLayout } from "./runtime-symbols.js";

/**
 * The single descriptor a domain package exports from its **package root** as `keymaDomain`.
 * It bundles the domain's contribution to every extension seam so a host (the CLI) can load
 * one well-known export and wire all the seams without naming any domain-specific symbol:
 *
 *  - `frontend`        → registered on the frontend's `FrontendExtensionRegistry`
 *  - `irValidator`     → registered on the IR `IRValidatorRegistry` (`defaultIRValidators`)
 *  - `classMetadata`   → the neutral per-class metadata-descriptor builder, fed to every backend
 *  - `runtimeTypeDecls`→ the JS-only runtime `.d.ts` type-surface block the JS backend appends
 *
 * There are no per-language backend *packs* anymore: a domain ships at most ONE neutral,
 * language-agnostic metadata-descriptor builder (the compiler renders it for every target). The
 * thesis holds — adding a domain needs no per-language backend code.
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
    /**
     * The neutral, language-agnostic per-class metadata-descriptor builder (the data-model domain
     * supplies it). Consumed by all three backends — each renders the descriptor into its
     * `<Class>.metadata` form. Omit when the domain contributes no class metadata (e.g. a
     * frontend-only domain); a build whose IR has classes requires exactly one domain to provide it.
     */
    classMetadata?: BuildClassData;
    /**
     * The domain's runtime type-declaration block (`ClassMetadata`/`ValidationError`/…), appended
     * by the JS backend to every bundle's `types.d.ts` alongside the compiler-owned service/request
     * surface. JS-only (the `.d.ts` type surface has no Python/C++ analogue). Omit when the domain
     * inlines no type surface.
     */
    runtimeTypeDecls?: () => string;
    /**
     * New primitive ops this domain contributes to the intrinsic registry — recognition (so the
     * frontend lowers them to `{kind:"intrinsic"}`) **and** per-language native-snippet emission.
     * Merged with the core registry by the host (the CLI registers them onto `defaultIntrinsics`).
     * Per-language emitters are optional; a configured target missing an emitter for an op a body
     * uses is caught by the driver's pre-emit compatibility scan. Omit when the domain adds no
     * new primitives — the structural shapes (methods, function values, metadata) need none. */
    intrinsics?: IntrinsicDef[];
    /**
     * Runtime-provided types this domain contributes to the compiler's runtime symbol table, as
     * `[canonicalName, perLanguageSymbols]` pairs (registered onto `defaultRuntimeSymbols` by the
     * host). An `{ kind: "external", name }` IR type resolves its per-language emitted symbol here;
     * an unregistered name falls back to the canonical name verbatim. Omit when the domain names no
     * runtime-provided types. */
    runtimeSymbols?: Array<readonly [string, RuntimeSymbols]>;
    /**
     * C++ aggregate layouts for the typed `{ kind: "record" }` IR node this domain emits, as
     * `[canonicalName, layout]` pairs (registered onto `defaultRecordLayouts` by the host). Drives
     * the C++ backend's typed-aggregate init (designated/positional, per-field pmr-string wrapping).
     * Omit when the domain emits no typed records. */
    recordLayouts?: Array<readonly [string, RecordLayout]>;
    /**
     * The target languages this domain supports (backend `target` ids — `"js"`/`"python"`/`"cpp"`).
     * When set, every configured build target must appear here or the build fails fast with a
     * config error (a domain that cannot emit for a requested language is a misconfiguration, not
     * a silent partial emit). Omit to impose no constraint (the domain supports every target). */
    targets?: string[];
}

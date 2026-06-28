import type { KeymaIR, IRClassDeclaration, IRFunctionDeclaration } from "@keyma/core/ir";
import type { EmitFile } from "../driver/index.js";

/**
 * Options the generic per-module emitter passes to a domain's `buildClassData`. The contract
 * between the bundle shell and the domain pack; carries only IR-derived data, so it stays
 * domain-neutral in `@keyma/compiler`.
 */
export type ClassDataOptions = {
    includePrivate: boolean;
    /** Which bundle is being emitted. A domain pack derives its own visibility/phase gating
     *  from this (e.g. a client bundle may keep only a subset of per-member reshaping). */
    bundle: "client" | "server" | "library";
    /** Every project-local function declaration keyed by name — a domain pack reads a
     *  referenced function's params from here to order its direct-ref call args. */
    functionDecls: ReadonlyMap<string, IRFunctionDeclaration>;
    /** Embedded/reference targets this class needs as a live `refs` dict:
     *  the target's `name` (lookup key) paired with its emitted Python class. */
    refs: readonly { name: string; className: string }[];
    /** Name of the module-level applyDefaults function to reference, if any. */
    applyDefaultsRef?: string;
};

/** Builds the per-class metadata dict attached as `<Class>.metadata`. */
export type BuildClassData = (cls: IRClassDeclaration, opts: ClassDataOptions) => Record<string, unknown>;

/**
 * A domain's Python emission contributions. The generic backend keeps the bundle shell (file
 * layout, visibility gating, class / literal emission) and dispatches the `<Class>.metadata`
 * dict to the registered pack. The data-model domain's pack is registered by the CLI;
 * `@keyma/compiler` references no domain symbol.
 *
 * Python omits services and enums (an architectural asymmetry with JS/C++), so the pack has
 * no service/enum hooks. The metadata's camelCase keys (`sourceName`, `applyDefaults`, `refs`,
 * …) are the cross-language runtime contract — a pack must not rename them.
 */
export type PythonEmitterPack = {
    name: string;
    /** Build the per-class `.metadata` dict. Provided by the data-model domain (the
     *  primary pack); a domain that only contributes bundle files (e.g. UI) omits it. */
    buildClassData?: BuildClassData;
    /**
     * Contribute extra files to each bundle, derived from the domain's own IR slice
     * (e.g. `ir.extensions['ui']`). Runs for **every** registered pack (not just the primary),
     * so a non-primary domain alongside the data-model domain can emit its own files. Omit when
     * the domain adds none — the data-model pack does, keeping single-domain bundles byte-identical.
     */
    emitBundleFiles?: (ir: KeymaIR, ctx: BundleEmitContext) => EmitFile[];
};

/**
 * The per-bundle context the shell passes to a domain's `emitBundleFiles` hook: the bundle
 * being emitted, its output root, and the private/public split.
 */
export type BundleEmitContext = {
    bundle: "client" | "server" | "library";
    bundleDir: string;
    includePrivate: boolean;
};

/** A per-language registry of domain emitter packs consulted by the generic Python backend. */
export class EmitterRegistry {
    private readonly packs: PythonEmitterPack[] = [];

    register(pack: PythonEmitterPack): void {
        this.packs.push(pack);
    }

    list(): readonly PythonEmitterPack[] {
        return this.packs;
    }

    /** The pack owning the core class metadata (the data-model domain). */
    primary(): PythonEmitterPack {
        const pack = this.packs[0];
        if (pack === undefined) throw new Error("no Python emitter pack registered");
        return pack;
    }
}

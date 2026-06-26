import type { KeymaIR, IRClassDeclaration, IRFunctionDeclaration } from "@keyma/core/ir";
import type { EmitFile } from "../driver/index.js";

/**
 * Options the generic per-module emitter passes to a domain's `buildSchemaData`. The contract
 * between the bundle shell and the domain pack; carries only IR-derived data, so it stays
 * domain-neutral in `@keyma/compiler`.
 */
export type SchemaDataOptions = {
    includePrivate: boolean;
    includeIndexes: boolean;
    formPhasesOnly: boolean;
    /** Every project-local function declaration keyed by name — a domain pack reads a
     *  validator/formatter factory's params from here to order its direct-ref call args. */
    functionDecls: ReadonlyMap<string, IRFunctionDeclaration>;
    /** Embedded/reference targets this schema needs as a live `refs` dict:
     *  the target's `name` (lookup key) paired with its emitted Python class. */
    refs: readonly { name: string; className: string }[];
    /** Name of the module-level applyDefaults function to reference, if any. */
    applyDefaultsRef?: string;
};

/** Builds the per-schema metadata dict attached as `<Class>.schema`. */
export type BuildSchemaData = (schema: IRClassDeclaration, opts: SchemaDataOptions) => Record<string, unknown>;

/**
 * A domain's Python emission contributions. The generic backend keeps the bundle shell (file
 * layout, visibility gating, class / literal emission) and dispatches the `<Class>.schema`
 * metadata to the registered pack. The schema domain's pack lives in
 * `@keyma/schema/backend-python`; the CLI registers it.
 *
 * Python omits services and enums (an architectural asymmetry with JS/C++), so the pack has
 * no service/enum hooks. The metadata's camelCase keys (`sourceName`, `applyDefaults`, `refs`,
 * …) are the cross-language runtime contract — a pack must not rename them.
 */
export type PythonEmitterPack = {
    name: string;
    /** Build the per-schema `.schema` metadata dict. Provided by the schema domain (the
     *  primary pack); a domain that only contributes bundle files (e.g. UI) omits it. */
    buildSchemaData?: BuildSchemaData;
    /**
     * Names of `functionDeclarations` this domain renders itself (with its own wrapper) via
     * `renderClaimedFunctions`, so the generic backend emits them through that hook rather than
     * as plain `def`s. The schema domain claims its validator/formatter factories (re-emitted as
     * runtime validator/formatter wrappers co-located in their source module). Omit when none.
     */
    claimFunctions?: (ir: KeymaIR) => ReadonlySet<string>;
    /**
     * Render the claimed (e.g. validator/formatter) functions a source module owns, with the
     * domain wrapper, one rendered `def` block per declaration (same order as `decls`). Spliced
     * into the module's body by the generic emitter. Present whenever `claimFunctions` is. The
     * full IR is passed so the domain can distinguish validator vs formatter factories.
     */
    renderClaimedFunctions?: (decls: readonly IRFunctionDeclaration[], ir: KeymaIR) => readonly string[];
    /**
     * Contribute extra files to each bundle, derived from the domain's own IR slice
     * (e.g. `ir.extensions['ui']`). Runs for **every** registered pack (not just the primary),
     * so a non-primary domain alongside schema can emit its own files. Omit when the domain
     * adds none — the schema pack does, keeping single-domain bundles byte-identical.
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

    /** The pack owning the core schema metadata (the schema domain). */
    primary(): PythonEmitterPack {
        const pack = this.packs[0];
        if (pack === undefined) throw new Error("no Python emitter pack registered");
        return pack;
    }
}

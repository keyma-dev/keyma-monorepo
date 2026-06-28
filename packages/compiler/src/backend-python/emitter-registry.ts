import type { KeymaIR, IRClassDeclaration } from "@keyma/core/ir";
import type { EmitFile, ClassMetadataOptions, MetadataClassDescriptor } from "../driver/index.js";

/**
 * Options the generic per-module emitter passes to a domain's `buildClassData`: the IR-neutral
 * visibility/bundle gate. The live `base`/`refs` are NOT passed — the compiler derives `base`
 * from `cls.extends` and computes the per-language `refs` symbols itself, then renders both.
 */
export type ClassDataOptions = ClassMetadataOptions;

/** Builds the per-class neutral metadata descriptor the compiler renders into `<Class>.metadata`. */
export type BuildClassData = (cls: IRClassDeclaration, opts: ClassDataOptions) => MetadataClassDescriptor;

/**
 * A domain's Python emission contributions. The generic backend keeps the bundle shell (file
 * layout, visibility gating, class / literal emission, and the live `<Class>.metadata`
 * rendering) and dispatches only the neutral metadata DESCRIPTOR to the registered pack. The
 * data-model domain's pack is registered by the CLI; `@keyma/compiler` references no domain symbol.
 *
 * Python omits services and enums (an architectural asymmetry with JS/C++), so the pack has
 * no service/enum hooks. `buildClassData` returns a neutral {@link MetadataClassDescriptor};
 * the compiler owns the rendered key identity (the cross-language runtime contract).
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

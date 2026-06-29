import type {
    KeymaIR,
    IRClassDeclaration,
} from "@keyma/core/ir";
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
 * The per-bundle context the shell passes to a domain's `emitBundleFiles` hook. Lets a
 * domain place its own files under the bundle root (`bundleDir`), gate by which bundle is
 * being emitted, and respect the same private/public split as the rest of the bundle.
 */
export type BundleEmitContext = {
    /** Which bundle is being emitted (client = public-only, server/library = full). */
    bundle: "client" | "server" | "library";
    /** Bundle-relative output root — join emitted file paths against this. */
    bundleDir: string;
    /** Whether private classes/members are included (server/library) or excluded (client). */
    includePrivate: boolean;
};

/** The deps the bundle shell passes to the built-in services emitter (`emit-service.ts`). */
export type ServiceEmitDeps = {
    /** Include private services and private methods (server/library bundles). */
    includePrivate: boolean;
    /** sourceName → bundle-relative source module ref (e.g. "src/user"). */
    classModule: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → emitted class symbol (for `.d.ts` types
     *  and the client `refs` Map value / model-import binding). */
    embeddedTypeNames: ReadonlyMap<string, string>;
};

/**
 * A domain's JS emission contributions. The generic backend keeps the bundle shell (file
 * layout, visibility gating, class / literal emission, the live `<Class>.metadata` rendering,
 * and the built-in services file) and dispatches to the registered pack only for the neutral
 * metadata DESCRIPTOR. The data-model domain's pack lives in a separate package; the CLI
 * registers it.
 *
 * NOTE: `buildClassData` returns a neutral {@link MetadataClassDescriptor} (pure data); the
 * compiler owns the rendered key identity (the cross-language runtime contract) and the live
 * `base`/`refs` fragments.
 */
export type JsEmitterPack = {
    name: string;
    /** Build the per-class `.metadata` object. Provided by the data-model domain (the
     *  primary pack); a domain that only contributes bundle files (e.g. UI) omits it. */
    buildClassData?: BuildClassData;
    /**
     * The domain's runtime type-declaration block, appended to each bundle's `types.d.ts`.
     * Lets a domain ship its own metadata `.d.ts` surface (e.g. `ClassMetadata`) alongside the
     * compiler-owned service/request types. Omit when the domain inlines no type surface.
     */
    runtimeTypeDecls?: () => string;
    /**
     * Contribute extra files to each bundle, derived from the domain's own IR slice
     * (e.g. `ir.extensions['ui']`). Unlike `buildClassData` (which only the first/primary
     * pack drives), this runs for **every** registered pack, so a non-primary domain (a UI
     * domain alongside the data model) can emit its own files. Omit when the domain adds no
     * bundle files — keeping single-domain bundles byte-identical.
     */
    emitBundleFiles?: (ir: KeymaIR, ctx: BundleEmitContext) => EmitFile[];
};

/** A per-language registry of domain emitter packs consulted by the generic JS backend. */
export class EmitterRegistry {
    private readonly packs: JsEmitterPack[] = [];

    register(pack: JsEmitterPack): void {
        this.packs.push(pack);
    }

    list(): readonly JsEmitterPack[] {
        return this.packs;
    }

    /** The pack owning the core class metadata (the data-model domain). */
    primary(): JsEmitterPack {
        const pack = this.packs[0];
        if (pack === undefined) throw new Error("no JS emitter pack registered");
        return pack;
    }
}

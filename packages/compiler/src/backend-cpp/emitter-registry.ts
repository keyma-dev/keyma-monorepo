import type {
    KeymaIR,
    IRClassDeclaration,
} from "@keyma/core/ir";
import type { EmitFile, ClassMetadataOptions, MetadataClassDescriptor } from "../driver/index.js";

/** Bundle-relative module ref (filename stem) of the services header (sits at the bundle root). */
export const SERVICES_REF = "services";
/** Bundle-relative module ref (filename stem) of the opt-in service-client header. */
export const SERVICE_CLIENT_REF = "service-client";

/**
 * Options the generic per-module emitter passes to a domain's `buildClassData`: the IR-neutral
 * visibility/bundle gate. The live `base`/`refs` are NOT passed — the compiler derives the base
 * FQN (`&Parent::metadata`) and computes the per-class ref FQNs itself, then renders both.
 */
export type ClassDataOptions = ClassMetadataOptions;

/** The deps the bundle shell passes to the built-in services emitter (`emit-service.ts`). */
export type ServiceEmitDeps = {
    /** Include private services and private methods (server/library bundles). */
    includePrivate: boolean;
    nsRoot: string;
    /** Complete `#include` token (with delimiters) for the runtime header. */
    runtimeInclude: string;
    /** Typed binary codec is enabled (the project-level `binary` config). When off, the generated
     *  dispatch / client marshals JSON only (the per-type `binary_traits<T>` for class params are
     *  emitted only under binary, so the binary branch would not compile). */
    binary: boolean;
    /** sourceName → bundle-relative model module ref (e.g. "models/user"). */
    classModule: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → emitted C++ class (`sourceName`). */
    classNameByName: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → fully-qualified C++ struct type. */
    cppTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → fully-qualified `enum class` type. */
    enumTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → bundle-relative module ref of its declaring file. */
    enumModuleByName: ReadonlyMap<string, string>;
};

/** The deps the bundle shell passes to the built-in service-client emitter (`emit-service-client.ts`). */
export type ServiceClientEmitDeps = {
    /** Include private services/methods (server/library bundles). */
    includePrivate: boolean;
    nsRoot: string;
    /** Complete `#include` token (with delimiters) for the runtime header (the umbrella). */
    runtimeInclude: string;
    /** Typed binary codec is enabled (see {@link ServiceEmitDeps.binary}). */
    binary: boolean;
    /** sourceName → bundle-relative model module ref (e.g. "models/user"). */
    classModule: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → emitted C++ class (`sourceName`). */
    classNameByName: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → fully-qualified C++ struct type. */
    cppTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → fully-qualified `enum class` type. */
    enumTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → bundle-relative module ref of its declaring file. */
    enumModuleByName: ReadonlyMap<string, string>;
};

/** Builds the per-class neutral metadata descriptor the compiler renders into the `metadata()`
 *  accessor. The compiler's `emitClassMeta` derives the typed `keyma::ClassMetadata` aggregate
 *  (TypeTag / element / target / bits / id-type tokens, the span-backed field array, and the live
 *  `base`/`refs`) from the descriptor + the per-class ref FQNs the bundle shell computes. */
export type BuildClassData = (cls: IRClassDeclaration, opts: ClassDataOptions) => MetadataClassDescriptor;

/**
 * A domain's C++ emission contributions. The generic backend keeps the bundle shell (file
 * layout, visibility gating, struct / value_traits / binary_traits emission, named-enum
 * emission, topological ordering, and the built-in service / service-client headers) and
 * dispatches only the neutral metadata DESCRIPTOR to the registered pack. The primary domain
 * pack (registered by the CLI) supplies it.
 *
 * `buildClassData` returns a neutral {@link MetadataClassDescriptor}; the compiler owns the
 * rendered key identity (the cross-language runtime contract).
 */
export type CppEmitterPack = {
    name: string;
    /** Build the per-class `metadata()` data as neutral data (the compiler renders it).
     *  Provided by the primary domain pack; a domain that only contributes bundle files
     *  (e.g. UI) omits it. */
    buildClassData?: BuildClassData;
    /**
     * Contribute extra files to each bundle, derived from the domain's own IR slice
     * (e.g. `ir.extensions['ui']`). Runs for **every** registered pack (not just the primary),
     * so a non-primary domain alongside the primary one can emit its own files. Omit when the
     * domain adds none — the primary pack does, keeping single-domain bundles byte-identical.
     */
    emitBundleFiles?: (ir: KeymaIR, ctx: BundleEmitContext) => EmitFile[];
};

/**
 * The per-bundle context the shell passes to a domain's `emitBundleFiles` hook: the bundle
 * being emitted, its output root, and the private/public split. C++ additionally threads the
 * root namespace and the runtime `#include` token (an asymmetry with JS, whose `emitBundleFiles`
 * needs neither) so a domain that emits a self-contained translation unit — the primary pack's
 * validators.hpp/formatters.hpp — can render its `namespace <root>::…` / `#include <runtime>`.
 */
export type BundleEmitContext = {
    bundle: "client" | "server" | "library";
    bundleDir: string;
    includePrivate: boolean;
    /** Root namespace (validators/formatters live under `<root>::validators` etc.). */
    nsRoot: string;
    /** Complete `#include` token (with delimiters) for the runtime header. */
    runtimeInclude: string;
};

/** A per-language registry of domain emitter packs consulted by the generic C++ backend. */
export class EmitterRegistry {
    private readonly packs: CppEmitterPack[] = [];

    register(pack: CppEmitterPack): void {
        this.packs.push(pack);
    }

    list(): readonly CppEmitterPack[] {
        return this.packs;
    }

    /** The pack owning the core class metadata (the primary domain). */
    primary(): CppEmitterPack {
        const pack = this.packs[0];
        if (pack === undefined) throw new Error("no C++ emitter pack registered");
        return pack;
    }
}

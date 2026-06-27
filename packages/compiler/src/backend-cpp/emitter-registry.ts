import type {
    KeymaIR,
    IRClassDeclaration,
    IRType,
    IRMember,
    IRFunctionDeclaration,
} from "@keyma/core/ir";
import type { EmitFile } from "../driver/index.js";

/** Bundle-relative module ref (filename stem) of the services header (sits at the bundle root). */
export const SERVICES_REF = "services";
/** Bundle-relative module ref (filename stem) of the opt-in service-client header. */
export const SERVICE_CLIENT_REF = "service-client";

/**
 * Options the generic per-module emitter passes to a domain's `buildClassData`. The contract
 * between the bundle shell and the domain pack; carries only IR-derived data, so it stays
 * domain-neutral in `@keyma/compiler`.
 */
export type ClassDataOptions = {
    includePrivate: boolean;
    /** Which bundle is being emitted. A domain derives its own per-bundle gating (e.g. index /
     *  phase inclusion) from this neutral value. */
    bundle: "client" | "server" | "library";
    /** Every project-local function declaration keyed by name — a domain pack reads a
     *  validator/formatter factory's params from here to order its direct-ref call args. */
    functionDecls: ReadonlyMap<string, IRFunctionDeclaration>;
    /** Embedded/reference targets: the target's `name` paired with its fully-qualified C++ struct. */
    refs: readonly { name: string; cppClass: string }[];
    /** Unqualified name of the apply_defaults free function to reference, if any. */
    applyDefaultsName?: string;
    /** Fully-qualified C++ type of the `extends` parent (for `.base = &Parent::metadata`), if any. */
    baseClass?: string;
    /** Root namespace. */
    nsRoot: string;
    /** A validator/formatter factory's fully-qualified namespace (its SOURCE module's namespace,
     *  e.g. `app::src::validators`) — the class metadata calls it like a cross-module ref target. */
    functionNamespace: (name: string) => string;
};

/** The deps the bundle shell passes to the built-in services emitter (`emit-service.ts`). */
export type ServiceEmitDeps = {
    /** Include private services and private methods (server/library bundles). */
    includePrivate: boolean;
    nsRoot: string;
    /** Complete `#include` token (with delimiters) for the runtime header. */
    runtimeInclude: string;
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

/**
 * One field's neutral metadata, produced by a domain's `buildClassData` and rendered into a
 * `keyma::FieldMeta` by the compiler's `emitClassMeta`. Carries the IR `type` raw — the
 * compiler derives the `TypeTag` / element / target / bits / id-type tokens, so the domain
 * emits no C++ type syntax. The `validators` / `formatters` factory-call fragments are the
 * domain's sole C++ contribution (the analogue of the JS model's `mkRaw` factory calls).
 */
export type CppFieldData = {
    name: string;
    /** The field's IR type — the compiler maps it to TypeTag / element / target / bits / id-type. */
    type: IRType;
    required: boolean;
    nullable?: boolean;
    readonly?: boolean;
    /** Private fields ride only in server/library metadata. */
    visibility?: "private";
    /** Field carries at least one index (server bundles); renders `.indexed = true`. */
    indexed?: boolean;
    /** Validator factory-call fragments, e.g. `keyma::validators::min_length(2)`. */
    validators?: readonly string[];
    /** Formatter entries: a neutral phase name + its factory-call fragment. */
    formatters?: readonly { phase: string; fn: string }[];
    /** Stable binary wire tag (present only with binary serialization). */
    tag?: number;
};

/**
 * A class's neutral metadata, produced by a domain's `buildClassData`. Language-neutral
 * but for the per-field validator/formatter factory-call fragments; the compiler's
 * `emitClassMeta` renders it into the span-backed `keyma::ClassMetadata` accessor body. The
 * camelCase identity keys are the cross-language runtime contract.
 */
export type CppClassData = {
    name: string;
    sourceName: string;
    visibility?: "private";
    ephemeral?: boolean;
    /** Unqualified `apply_defaults` free-function name to reference (`&name`), if any. */
    applyDefaults?: string;
    /** Fully-qualified C++ type of the `extends` parent — renders `.base = &Parent::metadata` so the
     *  runtime walks the chain (metadata carries OWN fields only). */
    base?: string;
    /** Embedded/reference targets: identity `name` + fully-qualified C++ class (for `&Class::metadata`). */
    refs: readonly { name: string; cppClass: string }[];
    /** Class-level indexes (already gated by the bundle); `fields` are bare field names. */
    indexes: readonly { fields: readonly string[]; unique: boolean }[];
    fields: readonly CppFieldData[];
};

/** Builds the per-class neutral metadata the compiler renders into the `metadata()` accessor. */
export type BuildClassData = (cls: IRClassDeclaration, opts: ClassDataOptions) => CppClassData;

/**
 * A domain's C++ emission contributions. The generic backend keeps the bundle shell (file
 * layout, visibility gating, struct / value_traits / binary_traits emission, named-enum
 * emission, topological ordering, and the built-in service / service-client headers) and
 * dispatches the domain-semantic neutral `metadata()` data to the registered pack. The
 * primary domain pack (registered by the CLI) supplies it.
 *
 * The metadata's camelCase keys (`sourceName`, `applyDefaults`, …) are the cross-language
 * runtime contract — a pack must not rename them.
 */
export type CppEmitterPack = {
    name: string;
    /** Build the per-class `metadata()` data as neutral data (the compiler renders it).
     *  Provided by the primary domain pack; a domain that only contributes bundle files
     *  (e.g. UI) omits it. */
    buildClassData?: BuildClassData;
    /**
     * The names of the functions a class's members reference (validators + formatters in the
     * data-model domain), so the generic backend can wire each model header's `#include` of the
     * factory's SOURCE module and seed per-bundle tree-shaking — without reading any domain slice
     * itself. Formatters are gated to form phases when `bundle === "client"`. The primary domain
     * pack implements it by reading its own extension slice; omit when a domain references none.
     */
    referencedFunctionNames?(
        members: readonly IRMember[],
        ctx: { bundle: "client" | "server" | "library" },
    ): ReadonlySet<string>;
    /**
     * Names of `functionDeclarations` this domain renders itself (with its own wrapper) via
     * `renderClaimedFunctions`, so the generic backend does not emit them as plain functions.
     * The primary domain claims its validator/formatter factories (re-emitted with the runtime
     * `ValidatorFn`/`FormatterFn` guard wrapper). Omit when the domain claims none.
     */
    claimFunctions?: (ir: KeymaIR) => ReadonlySet<string>;
    /**
     * Render the claimed functions a single source module owns, with the domain wrapper, for
     * splicing into that module's namespace. The generic module emitter passes the module's
     * claimed subset (in order) and `ir` (to classify each as a validator vs formatter). Returns
     * one `inline keyma::ValidatorFn`/`FormatterFn` definition per input declaration, in order.
     * Required when `claimFunctions` returns names.
     */
    renderClaimedFunctions?: (decls: readonly IRFunctionDeclaration[], ir: KeymaIR) => readonly string[];
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

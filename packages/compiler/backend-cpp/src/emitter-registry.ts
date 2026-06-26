import type {
    KeymaIR,
    IRSchema,
    IRService,
    IREnumDeclaration,
    IRValidatorDeclaration,
    IRFormatterDeclaration,
} from "@keyma/core/ir";
import type { EmitFile } from "../../driver/src/index.js";

/** Bundle-relative module ref (filename stem) of the services header (sits at the bundle root). */
export const SERVICES_REF = "services";
/** Bundle-relative module ref (filename stem) of the opt-in service-client header. */
export const SERVICE_CLIENT_REF = "service-client";

/**
 * Options the generic per-module emitter passes to a domain's `buildSchemaMeta`. The contract
 * between the bundle shell and the domain pack; carries only IR-derived data, so it stays
 * domain-neutral in `@keyma/compiler`.
 */
export type SchemaDataOptions = {
    includePrivate: boolean;
    includeIndexes: boolean;
    formPhasesOnly: boolean;
    validatorDecls: ReadonlyMap<string, IRValidatorDeclaration>;
    formatterDecls: ReadonlyMap<string, IRFormatterDeclaration>;
    /** Embedded/reference targets: the target's `name` paired with its fully-qualified C++ struct. */
    refs: readonly { name: string; cppClass: string }[];
    /** Unqualified name of the apply_defaults free function to reference, if any. */
    applyDefaultsName?: string;
    /** Root namespace (validators/formatters live under `<root>::validators` etc.). */
    nsRoot: string;
};

/** The deps the bundle shell passes to a domain's services emitter. */
export type ServiceEmitDeps = {
    /** Include private services and private methods (server/library bundles). */
    includePrivate: boolean;
    nsRoot: string;
    /** Complete `#include` token (with delimiters) for the runtime header. */
    runtimeInclude: string;
    /** sourceName → bundle-relative model module ref (e.g. "models/user"). */
    schemaModule: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → emitted C++ class (`sourceName`). */
    classNameByName: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → fully-qualified C++ struct type. */
    cppTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → fully-qualified `enum class` type. */
    enumTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → bundle-relative module ref of its declaring file. */
    enumModuleByName: ReadonlyMap<string, string>;
};

/** The deps the bundle shell passes to a domain's service-client emitter. */
export type ServiceClientEmitDeps = {
    /** Include private services/methods (server/library bundles). */
    includePrivate: boolean;
    nsRoot: string;
    /** sourceName → bundle-relative model module ref (e.g. "models/user"). */
    schemaModule: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → emitted C++ class (`sourceName`). */
    classNameByName: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → fully-qualified C++ struct type. */
    cppTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → fully-qualified `enum class` type. */
    enumTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → bundle-relative module ref of its declaring file. */
    enumModuleByName: ReadonlyMap<string, string>;
};

/** Builds the per-schema `keyma::SchemaMeta` accessor body (a C++ code string). */
export type BuildSchemaMeta = (schema: IRSchema, opts: SchemaDataOptions) => string;
/** Emit one named enum's `enum class` definition. */
export type EmitEnumClass = (decl: IREnumDeclaration) => string;
/** Emit one named enum's keyma:: conversions / traits. */
export type EmitEnumConversions = (decl: IREnumDeclaration, qualifiedType: string, binary?: boolean) => string;

/**
 * A domain's C++ emission contributions. The generic backend keeps the bundle shell (file
 * layout, visibility gating, struct / value_traits / binary_traits emission, topological
 * ordering) and dispatches the domain-semantic pieces — the `schema()` metadata body, the enum
 * `class` + keyma conversions, and the service/service-client headers — to the registered pack.
 * The schema domain's pack lives in `@keyma/schema/backend-cpp`; the CLI registers it.
 *
 * C++ adds enum + service-client headers (an asymmetry with JS, which has no enum files, and
 * Python, which has neither). The metadata's camelCase keys (`sourceName`, `applyDefaults`, …)
 * are the cross-language runtime contract — a pack must not rename them.
 */
export type CppEmitterPack = {
    name: string;
    /** Build the per-schema `schema()` accessor body. Provided by the schema domain (the
     *  primary pack); a domain that only contributes bundle files (e.g. UI) omits it. */
    buildSchemaMeta?: BuildSchemaMeta;
    /** Emit one named enum's `enum class` definition. (Schema domain; omit if no enums.) */
    emitEnumClass?: EmitEnumClass;
    /** Emit one named enum's keyma:: conversions / traits. (Schema domain; omit if no enums.) */
    emitEnumConversions?: EmitEnumConversions;
    /** Emit the bundle-root services.hpp; omit when the domain has no services. */
    emitServices?: (services: readonly IRService[], deps: ServiceEmitDeps) => string;
    /** Emit the bundle-root service-client.hpp; omit when the domain has no services. */
    emitServiceClient?: (services: readonly IRService[], deps: ServiceClientEmitDeps) => string;
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

/** A per-language registry of domain emitter packs consulted by the generic C++ backend. */
export class EmitterRegistry {
    private readonly packs: CppEmitterPack[] = [];

    register(pack: CppEmitterPack): void {
        this.packs.push(pack);
    }

    list(): readonly CppEmitterPack[] {
        return this.packs;
    }

    /** The pack owning the core schema metadata (the schema domain). */
    primary(): CppEmitterPack {
        const pack = this.packs[0];
        if (pack === undefined) throw new Error("no C++ emitter pack registered");
        return pack;
    }
}

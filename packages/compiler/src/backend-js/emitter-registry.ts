import type {
    KeymaIR,
    IRClassDeclaration,
    IRService,
    IRFunctionDeclaration,
} from "@keyma/core/ir";
import type { EmitFile } from "../driver/index.js";

/**
 * Options the generic per-module emitter passes to a domain's `buildSchemaData`. This is the
 * contract between the bundle shell (which knows visibility/index/default gating and resolves
 * the `refs`) and the domain pack (which assembles the `<Class>.schema` metadata). It carries
 * only IR-derived data, so it stays domain-neutral in `@keyma/compiler`.
 */
export type SchemaDataOptions = {
    /** Include private fields. */
    includePrivate: boolean;
    /** Include index metadata (field indexes, schema indexes). */
    includeIndexes: boolean;
    /** Client-only: restrict formatters to form phases (change/blur/submit). */
    formPhasesOnly: boolean;
    /** Include the per-schema `applyDefaults` arrow (server/library bundles only). */
    includeDefaults: boolean;
    /** Every project-local function declaration keyed by name — a domain pack reads a
     *  validator/formatter factory's params from here to order its direct-ref call args. */
    functionDecls: ReadonlyMap<string, IRFunctionDeclaration>;
    /** Embedded/reference targets this schema needs as a live `refs` Map:
     *  the target's `name` (lookup key) paired with its emitted class symbol. */
    refs: readonly { name: string; symbol: string }[];
};

/** Builds the per-schema metadata object attached as `<Class>.schema`. */
export type BuildSchemaData = (schema: IRClassDeclaration, opts: SchemaDataOptions) => Record<string, unknown>;

/** Context a domain's `shapeSchemaDts` hook needs to resolve target identities to symbols. */
export type SchemaDtsContext = {
    /** Reference/embedded/edge target `name` → emitted class symbol (`sourceName`). */
    embeddedTypeNames: ReadonlyMap<string, string>;
};

/**
 * A domain's override of a schema's `.d.ts` class declaration. Returned by `shapeSchemaDts`
 * when the default `export declare class <sourceName> { … }` is not enough — e.g. the schema
 * domain privatizes an edge class to `_X` and re-exports `X` as a branded const carrying the
 * `__edge` phantom. All fields are optional; an absent field keeps the generic default.
 */
export type SchemaDtsShape = {
    /** Override the class declaration's emitted name (default: `schema.sourceName`). */
    declName?: string;
    /** Override the class declaration keyword (default: `"export declare class"`). */
    declKeyword?: string;
    /** Lines appended after the class body (preceded by one blank line) — e.g. an edge's
     *  branded const + `InstanceType` alias. */
    trailer?: readonly string[];
    /** Extra ref-target identities to import in the `.d.ts` (e.g. an edge's from/to nodes). */
    importTargets?: readonly string[];
};

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
    /** Whether private schemas/fields are included (server/library) or excluded (client). */
    includePrivate: boolean;
};

/** The deps the bundle shell passes to a domain's services emitter. */
export type ServiceEmitDeps = {
    /** Include private services and private methods (server/library bundles). */
    includePrivate: boolean;
    /** sourceName → bundle-relative model module ref (e.g. "models/user/user"). */
    schemaModule: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → emitted class symbol (for `.d.ts` types
     *  and the client `refs` Map value / model-import binding). */
    embeddedTypeNames: ReadonlyMap<string, string>;
};

/**
 * A domain's JS emission contributions. The generic backend keeps the bundle shell (file
 * layout, visibility gating, class / literal emission) and dispatches to the registered pack
 * for the domain-semantic pieces: the `<Class>.schema` metadata object and the services file.
 * The schema domain's pack lives in `@keyma/schema/backend-js`; the CLI registers it.
 *
 * NOTE: the metadata produced by `buildSchemaData` uses camelCase keys (`sourceName`,
 * `applyDefaults`, `refs`, `tag`, …) — the cross-language runtime contract. A pack must
 * not rename them.
 */
export type JsEmitterPack = {
    name: string;
    /** Build the per-schema `.schema` metadata object. Provided by the schema domain (the
     *  primary pack); a domain that only contributes bundle files (e.g. UI) omits it. */
    buildSchemaData?: BuildSchemaData;
    /**
     * Override a schema's `.d.ts` class declaration when the domain needs more than a plain
     * `export declare class`. The schema domain uses it for edge schemas. Returns `undefined`
     * to keep the default. Consulted on the primary pack only (like `buildSchemaData`); inert
     * for plain schemas, so single-domain bundles stay byte-identical.
     */
    shapeSchemaDts?: (schema: IRClassDeclaration, ctx: SchemaDtsContext) => SchemaDtsShape | undefined;
    /** Emit the bundle-root services.js/.d.ts; omit when the domain has no services. */
    emitServices?: (services: readonly IRService[], deps: ServiceEmitDeps) => { js: string; dts: string };
    /**
     * Names of `functionDeclarations` this domain emits itself (with its own wrapper) via
     * `emitBundleFiles`, so the generic backend excludes them from `functions.js`. The schema
     * domain claims its validator/formatter factories (which it re-emits as `ValidatorFn`/
     * `FormatterFn` wrappers in `validators.js`/`formatters.js`). Omit when the domain claims none.
     */
    claimFunctions?: (ir: KeymaIR) => ReadonlySet<string>;
    /**
     * Contribute extra files to each bundle, derived from the domain's own IR slice
     * (e.g. `ir.extensions['ui']`). Unlike `buildSchemaData` (which only the first/primary
     * pack drives), this runs for **every** registered pack, so a non-primary domain (the UI
     * domain alongside schema) can emit its own files. Omit when the domain adds no bundle
     * files — the schema pack does, keeping single-domain bundles byte-identical.
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

    /** The pack owning the core schema metadata (the schema domain). */
    primary(): JsEmitterPack {
        const pack = this.packs[0];
        if (pack === undefined) throw new Error("no JS emitter pack registered");
        return pack;
    }
}

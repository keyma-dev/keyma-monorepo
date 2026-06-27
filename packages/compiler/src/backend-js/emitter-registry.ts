import type {
    KeymaIR,
    IRClassDeclaration,
    IRMember,
    IRFunctionDeclaration,
} from "@keyma/core/ir";
import type { EmitFile } from "../driver/index.js";

/**
 * Options the generic per-module emitter passes to a domain's `buildClassData`. This is the
 * contract between the bundle shell (which knows visibility/default gating and resolves the
 * `refs`) and the domain pack (which assembles the `<Class>.metadata` object). It carries only
 * IR-derived data, so it stays domain-neutral in `@keyma/compiler`.
 */
export type ClassDataOptions = {
    /** Include private members. */
    includePrivate: boolean;
    /** Which bundle is being emitted. A domain pack may gate its own per-bundle metadata
     *  (e.g. dropping server-only detail from the client bundle) off this value. */
    bundle: "client" | "server" | "library";
    /** Include the per-class `applyDefaults` arrow (server/library bundles only). */
    includeDefaults: boolean;
    /** Every project-local function declaration keyed by name — a domain pack reads a
     *  referenced function's params from here to order its direct-ref call args. */
    functionDecls: ReadonlyMap<string, IRFunctionDeclaration>;
    /** Embedded/reference targets this class needs as a live `refs` Map:
     *  the target's `name` (lookup key) paired with its emitted class symbol. */
    refs: readonly { name: string; symbol: string }[];
};

/** Builds the per-class metadata object attached as `<Class>.metadata`. */
export type BuildClassData = (cls: IRClassDeclaration, opts: ClassDataOptions) => Record<string, unknown>;

/** Context a domain's `shapeClassDts` hook needs to resolve target identities to symbols. */
export type ClassDtsContext = {
    /** Reference/embedded target `name` → emitted class symbol (`sourceName`). */
    embeddedTypeNames: ReadonlyMap<string, string>;
};

/**
 * A domain's override of a class's `.d.ts` declaration. Returned by `shapeClassDts` when the
 * default `export declare class <sourceName> { … }` is not enough — e.g. a domain privatizes a
 * relationship class to `_X` and re-exports `X` as a branded const carrying a phantom marker.
 * All fields are optional; an absent field keeps the generic default.
 */
export type ClassDtsShape = {
    /** Override the class declaration's emitted name (default: `cls.sourceName`). */
    declName?: string;
    /** Override the class declaration keyword (default: `"export declare class"`). */
    declKeyword?: string;
    /** Lines appended after the class body (preceded by one blank line) — e.g. a branded
     *  const + `InstanceType` alias. */
    trailer?: readonly string[];
    /** Extra ref-target identities to import in the `.d.ts` (e.g. a relationship's endpoints). */
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
 * One claimed function rendered within its source module. Since the function collapse these are
 * ordinary `IRFunctionDeclaration`s, but a domain may re-emit them with a runtime guard wrapper
 * rather than as plain functions. The generic module emitter places the rendering inside the
 * declaration's source module and resolves the cross-module utility-function imports its body
 * needs; the domain only supplies the bodies + the bundle `types`-module names the `.d.ts` uses.
 */
export type ClaimedFunctionRendering = {
    /** The `.js` definition, e.g. `export const minLength = (min) => (raw, field) => { … };`. */
    js: string;
    /** The `.d.ts` declaration, e.g. `export declare const minLength: (...args: unknown[]) => ValidatorFn;`. */
    dts: string;
    /** Type names this `.d.ts` declaration imports from the bundle `types` module (e.g. `ValidatorFn`). */
    dtsTypeImports: readonly string[];
};

/**
 * A domain's JS emission contributions. The generic backend keeps the bundle shell (file
 * layout, visibility gating, class / literal emission, and the built-in services file) and
 * dispatches to the registered pack for the domain-semantic `<Class>.metadata` object. The
 * data-model domain's pack lives in a separate package; the CLI registers it.
 *
 * NOTE: the metadata produced by `buildClassData` uses camelCase keys (`sourceName`,
 * `applyDefaults`, `refs`, `tag`, …) — the cross-language runtime contract. A pack must
 * not rename them.
 */
export type JsEmitterPack = {
    name: string;
    /** Build the per-class `.metadata` object. Provided by the data-model domain (the
     *  primary pack); a domain that only contributes bundle files (e.g. UI) omits it. */
    buildClassData?: BuildClassData;
    /**
     * Override a class's `.d.ts` declaration when the domain needs more than a plain
     * `export declare class`. Returns `undefined` to keep the default. Consulted on the
     * primary pack only (like `buildClassData`); inert for plain classes, so single-domain
     * bundles stay byte-identical.
     */
    shapeClassDts?: (cls: IRClassDeclaration, ctx: ClassDtsContext) => ClassDtsShape | undefined;
    /**
     * The function names a class's members reference (the domain reads its own member
     * extension slice — e.g. validator/formatter attachments). The generic backend seeds
     * tree-shaking and wires import statements from this set. Formatters et al. may be gated
     * to the client form phases when `ctx.bundle === "client"`. Omit when the domain attaches
     * no per-member functions.
     */
    referencedFunctionNames?: (
        members: readonly IRMember[],
        ctx: { bundle: "client" | "server" | "library" },
    ) => ReadonlySet<string>;
    /**
     * The domain's runtime type-declaration block, appended to each bundle's `types.d.ts`.
     * Lets a domain ship its own metadata `.d.ts` surface (e.g. `ClassMetadata`) alongside the
     * compiler-owned service/request types. Omit when the domain inlines no type surface.
     */
    runtimeTypeDecls?: () => string;
    /**
     * Names of `functionDeclarations` this domain renders itself (with its own wrapper) via
     * `renderClaimedFunctions`, so the generic backend does not emit them as plain functions.
     * A domain may claim its factory functions (re-emitted with a runtime guard wrapper). Omit
     * when the domain claims none.
     */
    claimFunctions?: (ir: KeymaIR) => ReadonlySet<string>;
    /**
     * Render the claimed functions a single source module owns, with the domain wrapper. The
     * generic module emitter passes the subset of a module's reachable functions whose names are
     * in `claimFunctions`, in module order, and splices each rendering into that module (resolving
     * the cross-module imports the body needs). Required when `claimFunctions` returns names.
     * `decls` is the module's claimed subset; `ir` is the full document (to classify each
     * rendering). Returns one rendering per input declaration, in order.
     */
    renderClaimedFunctions?: (decls: readonly IRFunctionDeclaration[], ir: KeymaIR) => readonly ClaimedFunctionRendering[];
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

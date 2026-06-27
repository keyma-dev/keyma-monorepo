import type ts from "typescript";
import type {
    IRDiagnostic,
    IRClassDeclaration,
    IRMember,
    IRFunctionDeclaration,
    TagManifest,
} from "@keyma/core/ir";
import type { EnumInfo } from "./discover-enums.js";
import type { FnRefVerdict } from "./lower-portable-expr.js";

/**
 * The neutral, per-compile inputs the compiler shares with a frontend domain. `diagnostics` is
 * the shared accumulator every pass pushes into; `namePrefix`/`binaryTags`/`tagManifest`/
 * `acceptTags` are the config a domain's check/normalize steps consult. The document envelope
 * (irVersion/compilerVersion) is assembled by the compiler driver, not a domain.
 */
export type DomainBaseContext = {
    checker: ts.TypeChecker;
    diagnostics: IRDiagnostic[];
    /** Explicit DSL-module override from config, if any. A domain applies its own default
     *  (its `dslModule`) when this is absent. */
    dslModuleName?: string;
    namePrefix: string;
    binaryTags: boolean;
    tagManifest?: TagManifest;
    acceptTags: boolean;
};

/**
 * The context a domain's per-class / per-program hooks receive. Extends the neutral base with the
 * derived facts the compiler computed while lowering: the full set of lowered class sourceNames,
 * the discovered enums, the shared function collector's `classify`, and the domain's own
 * per-compile `state` (from {@link FrontendDomain.init}).
 */
export type DomainContext = DomainBaseContext & {
    /** All lowered class sourceNames (every non-`@Service` non-declaration class). */
    classNames: ReadonlySet<string>;
    enums: ReadonlyMap<string, EnumInfo>;
    /** The shared (compiler-owned) function collector's classifier. */
    classify: (ident: ts.Identifier) => FnRefVerdict;
    /** The domain's per-compile state, produced by {@link FrontendDomain.init}. */
    state: unknown;
};

/**
 * The context a decorator handler receives while the compiler dispatches the member/class
 * decorators it owns. Carries the TS facilities a handler needs to read decorator arguments and
 * enrich the IR node, plus the owning class (so a member handler can accumulate class-level
 * state) and the domain's per-compile `state`.
 */
export type HandlerContext = {
    checker: ts.TypeChecker;
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
    /** The domain's resolved DSL module (config override or the domain's `dslModule` default). */
    dslModuleName: string;
    classNames: ReadonlySet<string>;
    enums: ReadonlyMap<string, EnumInfo>;
    classify: (ident: ts.Identifier) => FnRefVerdict;
    /** The class IR node owning the member being enriched (the class itself for a class decorator). */
    class: IRClassDeclaration;
    /** The domain's per-compile state, produced by {@link FrontendDomain.init}. */
    state: unknown;
};

/**
 * One decorator a domain owns. The compiler discovers it on a class (`target: "class"`) or a
 * stored field (`target: "member"`) by matching the identifier `name` resolved against `module`,
 * then calls `handle` to let the domain enrich the IR node (write `ir.extensions[domainId]`,
 * mutate the base type, accumulate class state, …). Getters/setters/methods are NOT dispatched —
 * a getter's domain decorators are reported as deferred (KEYMA098) by the base lowering.
 */
export type DomainDecorator = {
    name: string;
    /** Resolution module — the decorator is matched by `isFromModule(symbol, module)`. */
    module: string;
    target: "class" | "member";
    handle(node: ts.Decorator, ir: IRClassDeclaration | IRMember, ctx: HandlerContext): void;
};

/**
 * A frontend domain in the inverted control flow: a **declarative** descriptor. The compiler
 * owns DSL discovery, base-IR construction for every class, base validation, name normalization,
 * tag assignment, the function surface, and enum collection; a domain contributes only its slice:
 *
 *  - `decorators` — the class/member decorators it owns + their enrichment handlers (point 1+3).
 *  - `init` — optional per-compile state (e.g. a validator/formatter collector) threaded into
 *    every handler and hook via `ctx.state`.
 *  - `finalizeClass` — per-class aggregation after base IR + member handlers (point 5).
 *  - `check` — pre-normalize extra checks + lower domain factory functions (point 7).
 *  - `excludeFromFunctionSurface` — exclude predicate for the compiler's local-function sweep.
 *  - `afterNormalize` — rewrite the domain's extension cross-refs via the name map (point 8).
 *
 * (`@Service`/RPC is NOT a domain concern — the compiler owns it as a built-in base pass.)
 */
export interface FrontendDomain {
    name: string;
    /** The domain's canonical DSL module (its default when config supplies no override). */
    dslModule: string;
    decorators: DomainDecorator[];
    /** Build per-compile state (returned as `ctx.state` to every handler/hook). */
    init?(ctx: DomainBaseContext): unknown;
    /** Per-class aggregation, called for every lowered class; no-op on classes it didn't enrich. */
    finalizeClass?(cls: IRClassDeclaration, ctx: DomainContext): void;
    /** Pre-normalize extra checks (by sourceName) + lower domain factory functions. */
    check?(classes: readonly IRClassDeclaration[], ctx: DomainContext): { functionDeclarations?: IRFunctionDeclaration[] };
    /** Whether a project-local function with this return-type annotation is excluded from the
     *  compiler's eager local-function surface (a domain lowers its factory fns separately). */
    excludeFromFunctionSurface?(returnType: ts.TypeNode | undefined, ctx: DomainContext): boolean;
    /** Post-normalize: rewrite this domain's extension cross-references via the name map. */
    afterNormalize?(classes: readonly IRClassDeclaration[], nameMap: ReadonlyMap<string, string>, ctx: DomainContext): void;
    /** Contribute a document-level extension slice (written to `ir.extensions[domain.name]`).
     *  Used by domains whose artifact is a separate program-wide scan (e.g. the UI view catalog)
     *  rather than per-class enrichment. Returns `undefined` to contribute nothing. */
    documentExtension?(program: ts.Program, ctx: DomainContext): unknown | undefined;
}

/**
 * The seam through which frontend domains are registered. The CLI registers the domains it
 * wants, so `@keyma/compiler` imports no domain symbol and registering a further domain stays
 * purely additive.
 */
export class FrontendExtensionRegistry {
    private readonly registered: FrontendDomain[] = [];

    register(domain: FrontendDomain): void {
        this.registered.push(domain);
    }

    domains(): readonly FrontendDomain[] {
        return this.registered;
    }
}

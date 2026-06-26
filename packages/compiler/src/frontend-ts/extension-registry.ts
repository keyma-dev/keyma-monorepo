import type ts from "typescript";
import type {
    IRDiagnostic,
    IRClassDeclaration,
    IRService,
    IREnumDeclaration,
    IRFunctionDeclaration,
    TagManifest,
} from "@keyma/core/ir";

/**
 * The neutral inputs a frontend domain needs to lower a `ts.Program` into its slice of
 * the IR. `diagnostics` is the shared accumulator every pass pushes into; `schemaPrefix`,
 * `binaryTags`, `tagManifest` and `acceptTags` are the config a domain's normalize/finalize
 * steps consult. The document envelope (irVersion/compilerVersion) is assembled by the
 * generic orchestrator, not a domain.
 */
export type FrontendDomainContext = {
    checker: ts.TypeChecker;
    /** Explicit DSL-module override from config, if any. A domain applies its own default
     *  (the schema domain defaults to "@keyma/schema/dsl") when this is absent. */
    dslModuleName?: string;
    diagnostics: IRDiagnostic[];
    schemaPrefix: string;
    binaryTags: boolean;
    tagManifest?: TagManifest;
    acceptTags: boolean;
};

/**
 * One domain's contribution to the IR document. The generic orchestrator concatenates the
 * contributions of every registered domain and folds them into the envelope (each section
 * is included only when non-empty, preserving the historical IR shape). Phase 2 registers a
 * single domain — schema — so a contribution maps 1:1 onto today's IR.
 */
export type FrontendContribution = {
    schemas: IRClassDeclaration[];
    enums: IREnumDeclaration[];
    /** Project-local functions: utility helpers AND validator/formatter factories (now
     *  ordinary functions). A domain attaches per-field validator/formatter references via
     *  `field.extensions` rather than separate declaration lists. */
    functionDeclarations: IRFunctionDeclaration[];
    services: IRService[];
    /** Present only when the domain ran binary tag assignment (schema, when binaryTags). */
    tagManifest?: TagManifest;
    /**
     * Document-level extension data this domain contributes, keyed by its own domain id
     * (`{ ui: … }`). The orchestrator shallow-merges every domain's map into the envelope's
     * `extensions`, so domains must each write under their own key. Omit (or leave empty)
     * when the domain contributes none — a schema-only document then has no `extensions` and
     * stays byte-identical. The contributing domain's backend packs are the only readers.
     */
    extensions?: Record<string, unknown>;
};

/**
 * A frontend domain: discovers + lowers its own authoring surface from the program. The
 * schema domain (Phase 2's only one) owns the full @Schema/@Edge/@Service pipeline; a later
 * UI domain plugs in alongside it. The generic orchestrator (`compileProgram`) never needs to
 * know which domains exist — it just runs `produce` for each registered one.
 */
export interface FrontendDomain {
    name: string;
    produce(program: ts.Program, ctx: FrontendDomainContext): FrontendContribution;
}

/**
 * The seam through which frontend domains are registered. Phase 2 pre-registers the built-in
 * schema domain (see `compile.ts`); a later reorg phase moves that registration to the CLI so
 * `@keyma/compiler` imports no schema symbol, and registering a UI domain stays purely additive.
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

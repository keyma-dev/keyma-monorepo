/**
 * Compiler-side runtime symbol table for `{ kind: "external" }` IR types.
 *
 * An `external` type names a runtime-provided type by its **canonical name** (e.g. the name a
 * domain frontend lifts from a `@keyma/runtime` import — `ValidationError`, …). The compiler
 * emits the runtime that defines those types, so it is the defensible owner of the mapping from
 * a canonical name to the concrete per-language symbol each backend should reference.
 *
 * This is pure data — a small registry the per-language type emitters (`irTypeTo{Ts,Python,Cpp}`)
 * consult for the `external` case. A domain registers its runtime types here; an unregistered
 * canonical name falls back to the name verbatim (so a missing entry degrades to "emit the name
 * as written" rather than crashing a backend).
 */

/** The target languages a runtime symbol can be resolved for — the backend `target` ids. */
export type RuntimeSymbolLang = "js" | "python" | "cpp";

/** Per-language concrete symbols for one canonical runtime type. Any language may be omitted. */
export type RuntimeSymbols = {
    js?: string;
    python?: string;
    cpp?: string;
};

/**
 * A mutable registry mapping a runtime type's canonical name to its per-language emitted symbol.
 * Mirrors the {@link IntrinsicRegistry} pattern: a module-level `defaultRuntimeSymbols` singleton
 * backs the type emitters, and a host (the CLI) registers a domain's runtime types onto it.
 */
export class RuntimeSymbolRegistry {
    private readonly byName = new Map<string, RuntimeSymbols>();

    /** Register (or override) the per-language symbols for one canonical runtime type name. */
    register(canonicalName: string, symbols: RuntimeSymbols): void {
        this.byName.set(canonicalName, symbols);
    }

    /** Register many canonical-name → symbols entries, in iteration order. */
    registerAll(entries: Iterable<readonly [string, RuntimeSymbols]>): void {
        for (const [name, symbols] of entries) this.register(name, symbols);
    }

    /**
     * Resolve a canonical runtime type name to its emitted symbol for `lang`. Returns `undefined`
     * when the name is unregistered or has no symbol for that language — callers fall back to the
     * canonical name verbatim.
     */
    resolve(lang: RuntimeSymbolLang, canonicalName: string): string | undefined {
        return this.byName.get(canonicalName)?.[lang];
    }

    /** Whether a canonical runtime type name is registered (in any language). */
    has(canonicalName: string): boolean {
        return this.byName.has(canonicalName);
    }
}

/**
 * The default runtime symbol table backing the per-language type emitters. Seeded empty — no
 * built-in runtime types are mapped yet (the schema frontend will register its runtime types as
 * it begins lowering `external` types). A host registers domain runtime types onto it.
 */
export const defaultRuntimeSymbols = new RuntimeSymbolRegistry();

// ─── Record-layout table (typed `record` IR-node C++ aggregate init) ──────────────────────────

/** How a record property's value is constructed in the C++ typed aggregate:
 *  - `pmrString`: wrap on the in-scope allocator — `std::pmr::string(<v>, <allocVar>)`.
 *  - `passthrough`: emit the value verbatim (CTAD/conversion handles it). */
export type RecordFieldCtor = "pmrString" | "passthrough";

/**
 * The C++ aggregate-init layout for a typed `{ kind: "record" }` node keyed by its canonical
 * (`external`/`instance`) type name. `fields` are in struct-DECLARATION order (so designated init
 * is well-formed — C++ requires designated initializers in declaration order); `style` selects
 * designated (`.field = …`) vs positional (`{…}`) initialization. Runtime-type knowledge the
 * compiler legitimately owns (it emits the runtime that defines these aggregates).
 */
export type RecordLayout = {
    fields: { key: string; ctor: RecordFieldCtor }[];
    style: "designated" | "positional";
};

/**
 * A mutable registry mapping a record type's canonical name to its C++ aggregate layout. Mirrors
 * {@link RuntimeSymbolRegistry}; a host (the CLI) registers a domain's record layouts onto the
 * module-level {@link defaultRecordLayouts}, which the C++ `record` emitter consults.
 */
export class RecordLayoutRegistry {
    private readonly byName = new Map<string, RecordLayout>();

    /** Register (or override) the layout for one canonical record type name. */
    register(name: string, layout: RecordLayout): void {
        this.byName.set(name, layout);
    }

    /** Register many canonical-name → layout entries, in iteration order. */
    registerAll(entries: Iterable<readonly [string, RecordLayout]>): void {
        for (const [name, layout] of entries) this.register(name, layout);
    }

    /** Resolve the layout for a canonical record type name, or `undefined` when unregistered. */
    get(name: string): RecordLayout | undefined {
        return this.byName.get(name);
    }
}

/** The default record-layout table backing the C++ `record` emitter. Seeded empty; a host
 *  registers a domain's record layouts onto it (the schema domain registers `ValidationError`
 *  and `ValidatorCtx`). */
export const defaultRecordLayouts = new RecordLayoutRegistry();

/** Resolve a record type's C++ aggregate layout. Delegates to {@link defaultRecordLayouts}. */
export function recordLayout(name: string): RecordLayout | undefined {
    return defaultRecordLayouts.get(name);
}

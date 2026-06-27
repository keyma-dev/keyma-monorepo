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

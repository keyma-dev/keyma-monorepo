/**
 * Intrinsic operation registry — the language-neutral contract for the small set
 * of built-in string/array operations (plus `typeof`/`instanceof`) that frontends
 * recognize and backends must translate to idiomatic target code.
 *
 * This module is pure data: it answers "is this TS method/property a known
 * intrinsic, and what is its canonical op id, receiver, and arity". It deliberately
 * carries NO target-language syntax — each backend owns its own translation table
 * keyed by `op`.
 *
 * Tiers: a `required` intrinsic MUST be implemented by every backend; a
 * `recommended` intrinsic SHOULD be implemented (a backend may reject it if the
 * target cannot express it cleanly). See `intrinsics.md`.
 */

export type IntrinsicTier = "required" | "recommended";

/**
 * Where the intrinsic's value comes from:
 * - `string` / `array` / `regexp` / `date`: a method or property call on a receiver of that type.
 * - `value`: a unary/free-standing op (e.g. `type-is`, `instance-of`, the static `date.now`).
 */
export type IntrinsicReceiver = "string" | "array" | "regexp" | "date" | "value";

/** How the intrinsic is written in TypeScript source — a method call or a property read. */
export type IntrinsicForm = "method" | "property";

/**
 * A native-snippet emitter for a (usually domain-contributed) intrinsic op. It receives the
 * **already-emitted** receiver source (`null` for a free-standing op with no receiver) and the
 * **already-emitted** argument sources, and returns the target-language expression string. The
 * backend renders receiver/args with its own expression emitter, then hands the strings here, so
 * the emitter carries no IR knowledge — it is pure target syntax (decision 11, "native-snippet
 * only"). */
export type IntrinsicEmitter = (receiver: string | null, args: readonly string[]) => string;

/**
 * Per-language native-snippet emitters for an intrinsic op. Each language is **optional**: a
 * domain may emit for JS + C++ but not Python. A configured target that lacks an emitter for an
 * op its bodies use is caught by the driver's pre-emit compatibility scan (decision 11). The
 * built-in core intrinsics leave `emit` undefined — they are translated by each backend's own
 * (hardcoded) intrinsic table, not through the registry. */
export type IntrinsicEmit = {
    js?: IntrinsicEmitter;
    python?: IntrinsicEmitter;
    cpp?: IntrinsicEmitter;
};

export type IntrinsicDef = {
    /** Canonical op id, e.g. "string.includes". Unique across the registry. */
    op: string;
    receiver: IntrinsicReceiver;
    form: IntrinsicForm;
    /** The TypeScript member name (e.g. "includes", "length"). Empty for non-member ops. */
    tsName: string;
    /** Inclusive arg-count bounds (excludes the receiver). */
    minArgs: number;
    maxArgs: number;
    tier: IntrinsicTier;
    /**
     * Optional per-language native-snippet emitters. Set by a domain that contributes a NEW
     * primitive op the backends have no built-in translation for; omitted by the built-in core
     * intrinsics (which the backends translate directly). A backend consults this only when its
     * own intrinsic table has no entry for `op`. */
    emit?: IntrinsicEmit;
};

export const INTRINSICS: readonly IntrinsicDef[] = [
    // ── String methods ──────────────────────────────────────────────────────
    { op: "string.includes",    receiver: "string", form: "method",   tsName: "includes",    minArgs: 1, maxArgs: 1, tier: "required" },
    { op: "string.startsWith",  receiver: "string", form: "method",   tsName: "startsWith",  minArgs: 1, maxArgs: 1, tier: "required" },
    { op: "string.endsWith",    receiver: "string", form: "method",   tsName: "endsWith",    minArgs: 1, maxArgs: 1, tier: "required" },
    { op: "string.toLowerCase", receiver: "string", form: "method",   tsName: "toLowerCase", minArgs: 0, maxArgs: 0, tier: "required" },
    { op: "string.toUpperCase", receiver: "string", form: "method",   tsName: "toUpperCase", minArgs: 0, maxArgs: 0, tier: "required" },
    { op: "string.trim",        receiver: "string", form: "method",   tsName: "trim",        minArgs: 0, maxArgs: 0, tier: "required" },
    { op: "string.indexOf",     receiver: "string", form: "method",   tsName: "indexOf",     minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "string.slice",       receiver: "string", form: "method",   tsName: "slice",       minArgs: 1, maxArgs: 2, tier: "recommended" },
    { op: "string.charAt",      receiver: "string", form: "method",   tsName: "charAt",      minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "string.replace",     receiver: "string", form: "method",   tsName: "replace",     minArgs: 2, maxArgs: 2, tier: "recommended" },
    { op: "string.length",      receiver: "string", form: "property", tsName: "length",      minArgs: 0, maxArgs: 0, tier: "required" },

    // ── Array methods ───────────────────────────────────────────────────────
    { op: "array.includes",     receiver: "array",  form: "method",   tsName: "includes",    minArgs: 1, maxArgs: 1, tier: "required" },
    { op: "array.indexOf",      receiver: "array",  form: "method",   tsName: "indexOf",     minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "array.join",         receiver: "array",  form: "method",   tsName: "join",        minArgs: 0, maxArgs: 1, tier: "recommended" },
    { op: "array.filter",       receiver: "array",  form: "method",   tsName: "filter",      minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "array.map",          receiver: "array",  form: "method",   tsName: "map",         minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "array.some",         receiver: "array",  form: "method",   tsName: "some",        minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "array.every",        receiver: "array",  form: "method",   tsName: "every",       minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "array.length",       receiver: "array",  form: "property", tsName: "length",      minArgs: 0, maxArgs: 0, tier: "required" },

    // ── Regexp methods ────────────────────────────────────────────────────────
    { op: "regexp.test",        receiver: "regexp", form: "method",   tsName: "test",        minArgs: 1, maxArgs: 1, tier: "recommended" },

    // ── Date methods (read-only accessors; mutators are not portable) ─────────
    { op: "date.getTime",         receiver: "date", form: "method", tsName: "getTime",         minArgs: 0, maxArgs: 0, tier: "recommended" },
    { op: "date.getFullYear",     receiver: "date", form: "method", tsName: "getFullYear",     minArgs: 0, maxArgs: 0, tier: "recommended" },
    { op: "date.getMonth",        receiver: "date", form: "method", tsName: "getMonth",        minArgs: 0, maxArgs: 0, tier: "recommended" },
    { op: "date.getDate",         receiver: "date", form: "method", tsName: "getDate",         minArgs: 0, maxArgs: 0, tier: "recommended" },
    { op: "date.getDay",          receiver: "date", form: "method", tsName: "getDay",          minArgs: 0, maxArgs: 0, tier: "recommended" },
    { op: "date.getHours",        receiver: "date", form: "method", tsName: "getHours",        minArgs: 0, maxArgs: 0, tier: "recommended" },
    { op: "date.getMinutes",      receiver: "date", form: "method", tsName: "getMinutes",      minArgs: 0, maxArgs: 0, tier: "recommended" },
    { op: "date.getSeconds",      receiver: "date", form: "method", tsName: "getSeconds",      minArgs: 0, maxArgs: 0, tier: "recommended" },
    { op: "date.getMilliseconds", receiver: "date", form: "method", tsName: "getMilliseconds", minArgs: 0, maxArgs: 0, tier: "recommended" },
    { op: "date.toISOString",     receiver: "date", form: "method", tsName: "toISOString",     minArgs: 0, maxArgs: 0, tier: "recommended" },

    // ── Type inspection (no member; synthesized by the frontend) ─────────────
    // `type-is`: result of `typeof x === "<literal>"`. args[0] is the type name literal.
    { op: "type-is",            receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 1, tier: "required" },
    // `instance-of`: result of `x instanceof Ctor`. args[0] is the constructor-name literal.
    { op: "instance-of",        receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 1, tier: "required" },
    // `date.now`: result of the static `Date.now()`. No instance receiver, so it is synthesized by
    // the frontend (empty `tsName` keeps it out of BY_RECEIVER_NAME); resolve it via `intrinsicByOp`.
    { op: "date.now",           receiver: "value",  form: "method",   tsName: "",            minArgs: 0, maxArgs: 0, tier: "recommended" },

    // ── Math numerics (free-standing `Math.x(...)`; synthesized by the frontend) ───────────────
    // No instance receiver — recognized via the global `Math` identifier and emitted with
    // `receiver: null`, the args riding in `args`. Empty `tsName` keeps them out of
    // BY_RECEIVER_NAME (resolve via `intrinsicByOp("math.<name>")`).
    { op: "math.floor",         receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "math.ceil",          receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "math.round",         receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "math.trunc",         receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "math.abs",           receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "math.sign",          receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "math.sqrt",          receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "math.pow",           receiver: "value",  form: "method",   tsName: "",            minArgs: 2, maxArgs: 2, tier: "recommended" },
    // Variadic: `Math.min(a, b, …)` / `Math.max(…)`. At least one arg in practice.
    { op: "math.min",           receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 255, tier: "recommended" },
    { op: "math.max",           receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 255, tier: "recommended" },

    // ── Coercion (free-standing `String(x)` / `Number(x)`; synthesized by the frontend) ────────
    { op: "to-string",          receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 1, tier: "recommended" },
    { op: "to-number",          receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 1, tier: "recommended" },
];

/**
 * A mutable registry of intrinsic operations, indexed both by canonical op id and by
 * `receiver.tsName` member key. The built-in `INTRINSICS` are the language-neutral
 * defaults; a domain that needs extra intrinsics registers them so the frontend
 * recognizer and the IR `validateIR` intrinsic-op check pick them up — without editing
 * core. The default registry (`defaultIntrinsics`) backs the module-level
 * `intrinsicByOp`/`intrinsicByMember` lookups, so Phase-2 behaviour is unchanged: only
 * the built-in `INTRINSICS` are registered.
 */
export class IntrinsicRegistry {
    private readonly byOp = new Map<string, IntrinsicDef>();
    private readonly byReceiverName = new Map<string, IntrinsicDef>();

    /** Register one intrinsic. A later registration with the same op id overrides an earlier one. */
    register(def: IntrinsicDef): void {
        this.byOp.set(def.op, def);
        // Free-standing ops (`tsName === ""`) are resolved only via `byOpId`, mirroring
        // the original BY_RECEIVER_NAME filter so e.g. `date.now`/`math.*` stay out of it.
        if (def.tsName !== "") this.byReceiverName.set(`${def.receiver}.${def.tsName}`, def);
    }

    /** Register many intrinsics, in iteration order. */
    registerAll(defs: Iterable<IntrinsicDef>): void {
        for (const def of defs) this.register(def);
    }

    /** Look up an intrinsic by its canonical op id. */
    byOpId(op: string): IntrinsicDef | undefined {
        return this.byOp.get(op);
    }

    /** Look up a string/array/regexp/date member intrinsic by receiver type and TS member name. */
    byMember(receiver: "string" | "array" | "regexp" | "date", tsName: string): IntrinsicDef | undefined {
        return this.byReceiverName.get(`${receiver}.${tsName}`);
    }

    /** All registered intrinsics, in registration order. */
    all(): IntrinsicDef[] {
        return [...this.byOp.values()];
    }
}

/**
 * The op ids of the **built-in** core intrinsics. These are translated directly by each
 * backend's own intrinsic table (not through a registry `emit` snippet), so the driver's
 * pre-emit compatibility scan treats them as emittable for every target. A domain-contributed
 * op (one NOT in this set) must instead provide an `emit` snippet for each configured target. */
export const BUILTIN_INTRINSIC_OPS: ReadonlySet<string> = new Set(INTRINSICS.map((d) => d.op));

/** The default registry, seeded with the built-in language-neutral intrinsics. */
export const defaultIntrinsics = new IntrinsicRegistry();
defaultIntrinsics.registerAll(INTRINSICS);

/** Look up an intrinsic by its canonical op id. Delegates to {@link defaultIntrinsics}. */
export function intrinsicByOp(op: string): IntrinsicDef | undefined {
    return defaultIntrinsics.byOpId(op);
}

/**
 * Look up a string/array/regexp/date member intrinsic by receiver type and TS member name,
 * e.g. `("string", "includes")`. Returns undefined if not a known intrinsic. Delegates to
 * {@link defaultIntrinsics}.
 */
export function intrinsicByMember(receiver: "string" | "array" | "regexp" | "date", tsName: string): IntrinsicDef | undefined {
    return defaultIntrinsics.byMember(receiver, tsName);
}

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
 * - `string` / `array` / `regexp`: a method or property call on a receiver of that type.
 * - `value`: a unary op on any value (e.g. `type-is`, `instance-of`).
 */
export type IntrinsicReceiver = "string" | "array" | "regexp" | "value";

/** How the intrinsic is written in TypeScript source — a method call or a property read. */
export type IntrinsicForm = "method" | "property";

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
    { op: "array.length",       receiver: "array",  form: "property", tsName: "length",      minArgs: 0, maxArgs: 0, tier: "required" },

    // ── Regexp methods ────────────────────────────────────────────────────────
    { op: "regexp.test",        receiver: "regexp", form: "method",   tsName: "test",        minArgs: 1, maxArgs: 1, tier: "recommended" },

    // ── Type inspection (no member; synthesized by the frontend) ─────────────
    // `type-is`: result of `typeof x === "<literal>"`. args[0] is the type name literal.
    { op: "type-is",            receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 1, tier: "required" },
    // `instance-of`: result of `x instanceof Ctor`. args[0] is the constructor-name literal.
    { op: "instance-of",        receiver: "value",  form: "method",   tsName: "",            minArgs: 1, maxArgs: 1, tier: "required" },
];

const BY_OP = new Map<string, IntrinsicDef>(INTRINSICS.map((d) => [d.op, d]));

const BY_RECEIVER_NAME = new Map<string, IntrinsicDef>(
    INTRINSICS.filter((d) => d.tsName !== "").map((d) => [`${d.receiver}.${d.tsName}`, d]),
);

/** Look up an intrinsic by its canonical op id. */
export function intrinsicByOp(op: string): IntrinsicDef | undefined {
    return BY_OP.get(op);
}

/**
 * Look up a string/array/regexp member intrinsic by receiver type and TS member name,
 * e.g. `("string", "includes")`. Returns undefined if not a known intrinsic.
 */
export function intrinsicByMember(receiver: "string" | "array" | "regexp", tsName: string): IntrinsicDef | undefined {
    return BY_RECEIVER_NAME.get(`${receiver}.${tsName}`);
}

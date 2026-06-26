/**
 * A marker wrapping a raw target-language code fragment to be emitted verbatim (not
 * JSON-encoded) inside an object/array literal — e.g. a validator factory call
 * `minLength(2)`, a `new Map([...])`, or an `applyDefaults` arrow/lambda. Produced by a
 * backend's schema-data builder and rendered by that backend's own literal emitter.
 */
export type Raw = { readonly __raw: string };

/** Wrap a code fragment so a literal emitter renders it verbatim. */
export function mkRaw(code: string): Raw {
    return { __raw: code };
}

/** Type guard for {@link Raw} markers. */
export function isRaw(v: unknown): v is Raw {
    return typeof v === "object" && v !== null && "__raw" in v && typeof (v as Raw).__raw === "string";
}

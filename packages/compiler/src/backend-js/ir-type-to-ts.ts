import type { IRType } from "@keyma/core/ir";
import { defaultRuntimeSymbols } from "../driver/runtime-symbols.js";

/**
 * Map an IRType to a TypeScript type string for use in `.d.ts` files.
 *
 * - `reference` types store only the referenced document's ID → `string`
 * - `embedded` types store the full nested object → reference the class by symbol
 * - Temporal types: `dateTime` → `Date`, others → `string`
 */
export function irTypeToTs(
    type: IRType,
    /** Map of target `name` → emitted class symbol, for resolving reference/embedded
     *  target types to their generated class. */
    embeddedNames?: ReadonlyMap<string, string>
): string {
    switch (type.kind) {
        case "string":   return "string";
        case "number":   return "number";
        case "integer":  return "number";
        case "bigint":   return "bigint";
        case "boolean":  return "boolean";
        case "decimal":  return "string";
        case "bytes":    return "Uint8Array";
        case "date":     return "string";
        case "dateTime": return "Date";
        case "time":     return "string";
        case "id":       return "string";
        case "json":     return "unknown";

        case "enum":
            return type.values.map((v) => JSON.stringify(v)).join(" | ");

        case "array": {
            const el = `${maybeParens(type.of, embeddedNames)}[]`;
            return type.elementNullable ? `(${irTypeToTs(type.of, embeddedNames)} | null)[]` : el;
        }

        case "reference":
            return embeddedNames?.get(type.target) ?? type.target;

        case "embedded": {
            return embeddedNames?.get(type.target) ?? type.target;
        }

        // A live value of a class T (param/return position) — reference the class by symbol.
        case "instance":
            return embeddedNames?.get(type.name) ?? type.name;

        // A runtime-provided type, resolved to its emitted symbol via the runtime symbol table
        // (falls back to the canonical name verbatim when unregistered).
        case "external":
            return defaultRuntimeSymbols.resolve("js", type.name) ?? type.name;

        default:
            // `function` (param/return-position vocabulary) gains `.d.ts` emission in a later slice.
            throw new Error(`irTypeToTs: unsupported IR type kind "${(type as { kind: string }).kind}"`);
    }
}

/**
 * Build a JS boolean expression checking whether `value` matches `type`, for runtime
 * input guards on validators/formatters. Returns null when no structural check applies.
 */
export function jsTypeGuard(type: IRType, value: string): string | null {
    switch (type.kind) {
        case "string":
        case "id":
        case "date":
        case "time":
        case "decimal":
            return `typeof ${value} === "string"`;
        case "number":
            return `typeof ${value} === "number"`;
        case "integer":
            return `typeof ${value} === "number" && Number.isInteger(${value})`;
        case "bigint":
            return `typeof ${value} === "bigint"`;
        case "boolean":
            return `typeof ${value} === "boolean"`;
        case "bytes":
            return `${value} instanceof Uint8Array`;
        case "dateTime":
            return `${value} instanceof Date`;
        case "enum":
            return `[${type.values.map((v) => JSON.stringify(v)).join(", ")}].includes(${value})`;
        case "array":
            return `Array.isArray(${value})`;
        case "json":
        case "reference":
        case "embedded":
        case "instance":
            return null;
        default:
            // `function` is never an input-guard type in this slice.
            throw new Error(`jsTypeGuard: unsupported IR type kind "${(type as { kind: string }).kind}"`);
    }
}

/** A short human label for a type, used in runtime mismatch messages. */
export function irTypeLabel(type: IRType): string {
    switch (type.kind) {
        case "array":    return `array of ${irTypeLabel(type.of)}`;
        case "enum":     return `one of ${type.values.map((v) => JSON.stringify(v)).join(", ")}`;
        case "reference":
        case "embedded": return type.target;
        case "instance": return type.name;
        default:         return type.kind;
    }
}

/** Wrap complex types (union, array) in parens when used as an array element type. */
function maybeParens(type: IRType, names?: ReadonlyMap<string, string>): string {
    const ts = irTypeToTs(type, names);
    if (type.kind === "enum") {
        return `(${ts})`;
    }
    return ts;
}

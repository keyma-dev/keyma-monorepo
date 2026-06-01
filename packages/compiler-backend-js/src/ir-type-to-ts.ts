import type { IRType } from "@keyma/ir";

/**
 * Map an IRType to a TypeScript type string for use in `.d.ts` files.
 *
 * - `reference` types store only the referenced document's ID → `string`
 * - `embedded` types store the full nested object → reference the class by sourceName
 * - Temporal types: `dateTime` → `Date`, others → `string`
 */
export function irTypeToTs(
    type: IRType,
    /** Map of sourceName → sourceName for resolving embedded schema types. */
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
        case "regexp":   return "RegExp";

        case "enum":
            return type.values.map((v) => JSON.stringify(v)).join(" | ");

        case "nullable":
            return `${irTypeToTs(type.of, embeddedNames)} | null`;

        case "array":
            return `${maybeParens(type.of, embeddedNames)}[]`;

        case "reference":
            // References store only the ID
            return "string";

        case "embedded": {
            const name = embeddedNames?.get(type.schema) ?? type.schema;
            return name;
        }
    }
}

/** Wrap complex types (union, array) in parens when used as an array element type. */
function maybeParens(type: IRType, names?: ReadonlyMap<string, string>): string {
    const ts = irTypeToTs(type, names);
    if (type.kind === "nullable" || type.kind === "enum") {
        return `(${ts})`;
    }
    return ts;
}

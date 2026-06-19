import type { IRType } from "@keyma/ir";

/**
 * Map an IRType to a Python type hint string.
 */
export function irTypeToPython(
    type: IRType,
    /** Map of sourceName → sourceName for resolving embedded schema types. */
    embeddedNames?: ReadonlyMap<string, string>
): string {
    switch (type.kind) {
        case "string":   return "str";
        case "number":   return "float";
        case "integer":  return "int";
        case "bigint":   return "int";
        case "boolean":  return "bool";
        case "decimal":  return "str";
        case "bytes":    return "bytes";
        case "date":     return "str";
        case "dateTime": return "datetime"; // Requires from datetime import datetime
        case "time":     return "str";
        case "id":       return "str";
        case "json":     return "Any"; // Requires from typing import Any
        case "regexp":   return "str";

        case "enum":
            return `Literal[${type.values.map((v) => JSON.stringify(v)).join(", ")}]`; // Requires from typing import Literal

        case "nullable":
            return `Optional[${irTypeToPython(type.of, embeddedNames)}]`; // Requires from typing import Optional

        case "array":
            return `List[${irTypeToPython(type.of, embeddedNames)}]`; // Requires from typing import List

        case "reference":
            return embeddedNames?.get(type.schema) ?? type.schema;

        case "embedded": {
            return embeddedNames?.get(type.schema) ?? type.schema;
        }
    }
}

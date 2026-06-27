import type { IRType } from "@keyma/core/ir";

/**
 * Map an IRType to a Python type hint string.
 */
export function irTypeToPython(
    type: IRType,
    /** Map of target `name` → emitted Python class, for resolving reference/embedded
     *  member types to their generated class. */
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

        case "enum":
            return `Literal[${type.values.map((v) => JSON.stringify(v)).join(", ")}]`; // Requires from typing import Literal

        case "array": {
            const el = irTypeToPython(type.of, embeddedNames);
            return type.elementNullable
                ? `List[Optional[${el}]]` // Requires from typing import List, Optional
                : `List[${el}]`; // Requires from typing import List
        }

        case "reference":
            return embeddedNames?.get(type.target) ?? type.target;

        case "embedded": {
            return embeddedNames?.get(type.target) ?? type.target;
        }

        // A live value of a class T (param/return position) — reference the class.
        case "instance":
            return embeddedNames?.get(type.name) ?? type.name;

        default:
            // `function` (param/return-position vocabulary) gains Python emission in a later slice.
            throw new Error(`irTypeToPython: unsupported IR type kind "${(type as { kind: string }).kind}"`);
    }
}

/**
 * Build a Python boolean expression that checks whether `value` matches `type`, for
 * runtime input guards on a domain's per-member helpers. Returns null when no meaningful
 * structural check applies (e.g. `json`, class references).
 */
export function irTypeGuard(type: IRType, value: string): string | null {
    switch (type.kind) {
        case "string":
        case "id":
        case "date":
        case "time":
        case "decimal":
            return `isinstance(${value}, str)`;
        case "number":
            return `isinstance(${value}, (int, float)) and not isinstance(${value}, bool)`;
        case "integer":
        case "bigint":
            return `isinstance(${value}, int) and not isinstance(${value}, bool)`;
        case "boolean":
            return `isinstance(${value}, bool)`;
        case "bytes":
            return `isinstance(${value}, (bytes, bytearray))`;
        case "dateTime":
            return `isinstance(${value}, datetime)`;
        case "enum":
            return `${value} in (${type.values.map((v) => JSON.stringify(v)).join(", ")})`;
        case "array":
            return `isinstance(${value}, list)`;
        case "json":
        case "reference":
        case "embedded":
        case "instance":
            return null;
        default:
            // `function` is never an input-guard type in this slice.
            throw new Error(`irTypeGuard: unsupported IR type kind "${(type as { kind: string }).kind}"`);
    }
}

/** A short human label for a type, used in runtime mismatch messages. */
export function irTypeLabel(type: IRType): string {
    switch (type.kind) {
        case "array":    return `list of ${irTypeLabel(type.of)}`;
        case "enum":     return `one of ${type.values.map((v) => JSON.stringify(v)).join(", ")}`;
        case "reference":
        case "embedded": return type.target;
        case "instance":  return type.name;
        default:         return type.kind;
    }
}

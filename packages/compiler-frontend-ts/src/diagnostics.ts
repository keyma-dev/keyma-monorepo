import type { IRDiagnostic, IRSourceLocation } from "@keyma/ir";

// Schema-level structural errors
export const KEYMA001 = "KEYMA001"; // Duplicate schema name
export const KEYMA002 = "KEYMA002"; // Schema missing name

// Field-level errors
export const KEYMA010 = "KEYMA010"; // Unknown field type
export const KEYMA011 = "KEYMA011"; // Non-literal decorator argument
export const KEYMA012 = "KEYMA012"; // Validator/formatter incompatible with field type
export const KEYMA013 = "KEYMA013"; // Missing required option on parameterized marker
export const KEYMA014 = "KEYMA014"; // Unsupported computed getter expression
export const KEYMA015 = "KEYMA015"; // Computed getter must have no setter

// Validator / formatter errors
export const KEYMA020 = "KEYMA020"; // Unknown validator
export const KEYMA021 = "KEYMA021"; // Unknown formatter
export const KEYMA022 = "KEYMA022"; // Unknown custom validator (not registered)
export const KEYMA023 = "KEYMA023"; // Unknown custom formatter (not registered)
export const KEYMA024 = "KEYMA024"; // Empty enum values list

// Visibility and inheritance errors
export const KEYMA031 = "KEYMA031"; // Public schema leaks private schema
export const KEYMA032 = "KEYMA032"; // Public schema extends private parent
export const KEYMA033 = "KEYMA033"; // Child extends a non-@Schema-decorated class
export const KEYMA034 = "KEYMA034"; // Child field overrides parent with incompatible type

// Index errors
export const KEYMA016 = "KEYMA016"; // Invalid @Indexed direction value (must be 1, -1, or "text")
export const KEYMA017 = "KEYMA017"; // Composite index key has conflicting unique/sparse across fields

// Naming and duplication errors
export const KEYMA040 = "KEYMA040"; // Duplicate field name

// Generics and unsupported language features
export const KEYMA050 = "KEYMA050"; // Unsupported generic type parameter

// Edge schema errors
export const KEYMA060 = "KEYMA060"; // @Edge `from` or `to` references unknown schema
export const KEYMA061 = "KEYMA061"; // Edge from/to field missing or wrong type (not a reference to the named schema)
export const KEYMA062 = "KEYMA062"; // Edge from/to field not indexed
export const KEYMA063 = "KEYMA063"; // @Edge `from`/`to` argument is not a class identifier
export const KEYMA064 = "KEYMA064"; // Edge schema cannot itself be referenced by another schema as a node

// Reference errors
export const KEYMA070 = "KEYMA070"; // Reference<T> target schema has no `id: ID` field

export function mkError(
    code: string,
    message: string,
    source?: IRSourceLocation
): IRDiagnostic {
    return source !== undefined
        ? { code, severity: "error", message, source }
        : { code, severity: "error", message };
}

export function mkWarning(
    code: string,
    message: string,
    source?: IRSourceLocation
): IRDiagnostic {
    return source !== undefined
        ? { code, severity: "warning", message, source }
        : { code, severity: "warning", message };
}

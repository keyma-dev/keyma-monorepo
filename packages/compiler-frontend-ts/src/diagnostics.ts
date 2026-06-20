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
export const KEYMA015 = "KEYMA015"; // (obsolete) Computed getter must have no setter — a getter/setter pair is now allowed (getter = computed field, setter = behavior)
export const KEYMA018 = "KEYMA018"; // Computed getter dependency cycle (incl. self-reference)
export const KEYMA019 = "KEYMA019"; // Getter without @Computed is ignored / @Computed on a non-getter

// Validator / formatter errors
export const KEYMA020 = "KEYMA020"; // Unknown validator
export const KEYMA021 = "KEYMA021"; // Unknown formatter
export const KEYMA022 = "KEYMA022"; // Unknown custom validator (not registered)
export const KEYMA023 = "KEYMA023"; // Unknown custom formatter (not registered)
export const KEYMA024 = "KEYMA024"; // Empty enum values list
export const KEYMA025 = "KEYMA025"; // Unsupported enum member (numeric/heterogeneous/computed)

// Visibility and inheritance errors
export const KEYMA031 = "KEYMA031"; // Public schema leaks private schema
export const KEYMA032 = "KEYMA032"; // Public schema extends private parent
export const KEYMA033 = "KEYMA033"; // Child extends a non-@Schema-decorated class
export const KEYMA034 = "KEYMA034"; // Child field overrides parent with incompatible type
export const KEYMA035 = "KEYMA035"; // Persisted schema references an ephemeral schema via Reference<T>
export const KEYMA036 = "KEYMA036"; // Indexes declared on an ephemeral schema have no effect

// Index errors
export const KEYMA016 = "KEYMA016"; // Invalid @Indexed direction value (must be 1, -1, or "text")
export const KEYMA017 = "KEYMA017"; // Composite index key has conflicting unique/sparse across fields

// Naming and duplication errors
export const KEYMA040 = "KEYMA040"; // Duplicate member name (field, method, or setter)

// Generics and unsupported language features
export const KEYMA050 = "KEYMA050"; // Unsupported generic type parameter

// Edge schema errors
export const KEYMA060 = "KEYMA060"; // @Edge `from` or `to` points at an edge schema (must be a node)
export const KEYMA061 = "KEYMA061"; // Edge @From()/@To() endpoint field is not a node reference type
export const KEYMA062 = "KEYMA062"; // (obsolete) Edge from/to field not indexed — endpoints are now auto-indexed
export const KEYMA063 = "KEYMA063"; // (obsolete) @Edge `from`/`to` argument is not a class identifier — from/to now come from @From()/@To() fields
export const KEYMA064 = "KEYMA064"; // Edge schema cannot itself be referenced by another schema as a node
export const KEYMA065 = "KEYMA065"; // Edge schema missing a @From() and/or @To() endpoint field
export const KEYMA066 = "KEYMA066"; // Edge schema declares more than one @From() or @To() field

// Reference errors
export const KEYMA070 = "KEYMA070"; // Reference<T> target schema has no `id: ID` field
export const KEYMA071 = "KEYMA071"; // Bare @Schema class field — must be explicit Reference<T> or Embedded<T>

// Validator/formatter declaration compilation errors
export const KEYMA080 = "KEYMA080"; // @Validator/@Formatter applied to non-exported or non-function declaration
export const KEYMA081 = "KEYMA081"; // Factory body does not return a function expression
export const KEYMA082 = "KEYMA082"; // Unsupported statement or expression in validator/formatter body
export const KEYMA083 = "KEYMA083"; // Inner function has wrong arity (must have 2–3 params: value, fieldKey[, context])
export const KEYMA084 = "KEYMA084"; // Validator/formatter input (value) param must have an explicit type (not unknown/any/unannotated)
export const KEYMA085 = "KEYMA085"; // String/array method (or member) is not a supported intrinsic, or its receiver type is unresolved
export const KEYMA086 = "KEYMA086"; // Referenced utility function cannot be compiled (not project-local, untyped, or unsupported body)
export const KEYMA087 = "KEYMA087"; // Unsupported `instanceof` right-hand constructor (outside the portable set)

// Default value errors
export const KEYMA090 = "KEYMA090"; // Default initializer value incompatible with the field type
export const KEYMA091 = "KEYMA091"; // OBSOLETE — defaults are now property initializers; non-literal forms self-report via KEYMA082/085/086/087

// Method / setter behavior errors
export const KEYMA092 = "KEYMA092"; // Method/setter parameter or return type must be explicitly annotated (portable subset)

// Service (remote function call) errors
export const KEYMA093 = "KEYMA093"; // Service method must be abstract (a signature with no body)
export const KEYMA094 = "KEYMA094"; // Duplicate method name within a service
export const KEYMA095 = "KEYMA095"; // @Service combined with @Schema/@Edge on the same class
export const KEYMA096 = "KEYMA096"; // Public service method exposes a private schema via a parameter/return type
export const KEYMA097 = "KEYMA097"; // Duplicate service name, or service name collides with a schema name

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

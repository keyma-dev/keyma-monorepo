// Diagnostic constructors are shared across the compiler; re-exported here so call sites can keep
// importing them alongside the KEYMA#### code constants from this module.
export { mkError, mkWarning } from "@keyma/core/util";

// Portable-lowering diagnostics owned by `@keyma/compiler/frontend-ts` — emitted by the
// generic body / expression / validator / formatter / method lowering machinery that
// stays in the compiler. The schema-domain diagnostic codes live in
// `@keyma/schema/frontend-ts/diagnostics.ts`.
//
// Codes are NEVER renumbered (see CLAUDE.md). The bands are split by which package emits
// them, not by a contiguous range — so the numbers below are intentionally
// non-contiguous. Reserved future `@keyma/compiler` band: KEYMA0200–0299.

// Validator / formatter / getter body lowering (the portable expression/statement subset)
export const KEYMA014 = "KEYMA014"; // Unsupported getter accessor body expression
export const KEYMA080 = "KEYMA080"; // @Validator/@Formatter applied to non-exported or non-function declaration
export const KEYMA081 = "KEYMA081"; // Factory body does not return a function expression
export const KEYMA082 = "KEYMA082"; // Unsupported statement or expression in validator/formatter body
export const KEYMA083 = "KEYMA083"; // Inner function has wrong arity (must have 2–3 params: value, fieldKey[, context])
export const KEYMA084 = "KEYMA084"; // Validator/formatter input (value) param must have an explicit type (not unknown/any/unannotated)
export const KEYMA085 = "KEYMA085"; // String/array method (or member) is not a supported intrinsic, or its receiver type is unresolved
export const KEYMA086 = "KEYMA086"; // Referenced utility function cannot be compiled (not project-local, untyped, or unsupported body)
export const KEYMA087 = "KEYMA087"; // Unsupported `instanceof` right-hand constructor (outside the portable set)

// Method / setter behavior errors
export const KEYMA092 = "KEYMA092"; // Method/setter parameter or return type must be explicitly annotated (portable subset)

// TS-type → IR-type mapping (the generic `map-type` engine, shared by schema extraction and
// the generic validator/method/function lowering, stays in the compiler).
export const KEYMA010 = "KEYMA010"; // Unknown field type
export const KEYMA024 = "KEYMA024"; // Empty enum values list
export const KEYMA025 = "KEYMA025"; // Unsupported enum member (numeric/heterogeneous/computed)
export const KEYMA050 = "KEYMA050"; // Unsupported generic type parameter
export const KEYMA071 = "KEYMA071"; // Bare @Schema class field — must be explicit Reference<T> or Embedded<T>
export const KEYMA099 = "KEYMA099"; // Invalid numeric width: Integer/Unsigned<Bits> must be 8|16|32|64; Float<Bits> must be 32|64

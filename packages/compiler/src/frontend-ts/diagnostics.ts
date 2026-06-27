// Diagnostic constructors are shared across the compiler; re-exported here so call sites can keep
// importing them alongside the KEYMA#### code constants from this module.
export { mkError, mkWarning } from "@keyma/core/util";

// Portable-lowering diagnostics owned by `@keyma/compiler/frontend-ts` — emitted by the
// generic body / expression / function / method lowering machinery that stays in the
// compiler. A domain's own diagnostic codes live in that domain's `frontend-ts/diagnostics.ts`.
//
// Codes are NEVER renumbered (see CLAUDE.md). The bands are split by which package emits
// them, not by a contiguous range — so the numbers below are intentionally
// non-contiguous. Reserved future `@keyma/compiler` band: KEYMA0200–0299.

// Portable function / getter body lowering (the portable expression/statement subset)
export const KEYMA014 = "KEYMA014"; // Unsupported getter accessor body expression
export const KEYMA080 = "KEYMA080"; // Factory marker applied to non-exported or non-function declaration
export const KEYMA081 = "KEYMA081"; // Factory body does not return an inner function expression
export const KEYMA082 = "KEYMA082"; // Unsupported statement or expression in a portable function body
export const KEYMA083 = "KEYMA083"; // Inner function has wrong arity (must have 2–3 params: value, fieldKey[, context])
export const KEYMA084 = "KEYMA084"; // Portable function input (value) param must have an explicit type (not unknown/any/unannotated)
export const KEYMA085 = "KEYMA085"; // String/array method (or member) is not a supported intrinsic, or its receiver type is unresolved
export const KEYMA086 = "KEYMA086"; // Referenced utility function cannot be compiled (not project-local, untyped, or unsupported body)
export const KEYMA087 = "KEYMA087"; // Unsupported `instanceof` right-hand constructor (outside the portable set)

// Method / setter behavior errors
export const KEYMA092 = "KEYMA092"; // Method/setter parameter or return type must be explicitly annotated (portable subset)

// Service (@Service / remote function call) errors. `@Service` is a base-language concern the
// compiler owns end-to-end (discovery → extraction → checks live in the service base pass), so
// its codes live here. Numbers are historically allocated in the 09x band and are NEVER
// renumbered (see CLAUDE.md) — only their ownership moved here from a domain.
export const KEYMA093 = "KEYMA093"; // Service method must be abstract (a signature with no body)
export const KEYMA094 = "KEYMA094"; // Duplicate method name within a service
export const KEYMA095 = "KEYMA095"; // @Service class is also a data model (the same class is a contributed model class)
export const KEYMA096 = "KEYMA096"; // Public service method exposes a private model class via a parameter/return type
export const KEYMA097 = "KEYMA097"; // Duplicate service name, or service name collides with a model-class name

// Control-flow lowering — loops (011), constructor (008) and destructor (009). These live in
// the compiler-owned reserved band KEYMA0200–0299 (see the band note above), kept distinct
// from a domain's own higher bands.
export const KEYMA0201 = "KEYMA0201"; // C-style `for (init; cond; update)` desugared to a `while` loop (warning)
export const KEYMA0202 = "KEYMA0202"; // `continue` inside a C-style `for` is not portable (the while-desugar can't run the update step)
export const KEYMA0203 = "KEYMA0203"; // `for…in` is not portable — iterate `Object.keys`/`Object.entries` with `for…of`
export const KEYMA0204 = "KEYMA0204"; // Unsupported loop binding — `for…of`/C-style-`for` need a single `const`/simple identifier binding (no let/var/destructuring)
export const KEYMA0205 = "KEYMA0205"; // Labeled `break`/`continue` is not portable
export const KEYMA0206 = "KEYMA0206"; // A destructor must be a no-parameter, void-returning, synchronous method
export const KEYMA0207 = "KEYMA0207"; // A constructor may not be async

// TS-type → IR-type mapping (the generic `map-type` engine, shared by a domain's class
// extraction and the generic method/function lowering, stays in the compiler).
export const KEYMA010 = "KEYMA010"; // Unknown field type
export const KEYMA024 = "KEYMA024"; // Empty enum values list
export const KEYMA025 = "KEYMA025"; // Unsupported enum member (numeric/heterogeneous/computed)
export const KEYMA050 = "KEYMA050"; // Unsupported generic type parameter
export const KEYMA071 = "KEYMA071"; // Bare model-class field — must be explicit Reference<T> or Embedded<T>
export const KEYMA099 = "KEYMA099"; // Invalid numeric width: Integer/Unsigned<Bits> must be 8|16|32|64; Float<Bits> must be 32|64

// Base-language structural + visibility + inheritance checks the compiler owns (the
// class-lowering engine builds real `extends` links and the public/private surface, and
// validates them). Numbers are historically allocated in the 00x/03x bands and are NEVER
// renumbered (see CLAUDE.md) — only their ownership moved here from the schema domain.
export const KEYMA001 = "KEYMA001"; // Duplicate class name
export const KEYMA031 = "KEYMA031"; // Public class leaks private class (via reference/embedded)
export const KEYMA032 = "KEYMA032"; // Public class extends private parent
export const KEYMA033 = "KEYMA033"; // Child extends a class that is not a lowered class
export const KEYMA034 = "KEYMA034"; // Child field overrides parent with incompatible type
export const KEYMA037 = "KEYMA037"; // Public class has only private fields (no public surface)

// Base class-lowering checks the compiler owns (the per-class member walk: fields, methods,
// getters/setters/ctor/dtor, defaults, core decorators). Numbers are historically allocated and
// NEVER renumbered (see CLAUDE.md) — only their ownership moved here from the schema domain.
export const KEYMA040 = "KEYMA040"; // Duplicate member name (field, method, getter, or setter)
export const KEYMA090 = "KEYMA090"; // Default initializer value incompatible with the field type
export const KEYMA098 = "KEYMA098"; // Field-only decorator on a getter is ignored (computed-field support deferred)

// Binary tag manifest errors (the `assignTags` pass — stable wire identity). `@Service`-style
// base-language ownership: the compiler runs binary tag assignment, so its codes live here.
// Numbers are historically allocated in the 1xx band and are NEVER renumbered — only ownership
// moved here from the schema domain.
export const KEYMA100 = "KEYMA100"; // Field tag drift (suspected un-hinted rename) — re-run with --accept-tags, or add @RenamedFrom/@Tag
export const KEYMA101 = "KEYMA101"; // @RenamedFrom("old") names a field absent from the committed manifest
export const KEYMA102 = "KEYMA102"; // @Tag(n) invalid (must be a positive integer literal in range 1..2147483647)
export const KEYMA103 = "KEYMA103"; // Duplicate/reused tag within a schema (incl. reusing a tombstoned tag)

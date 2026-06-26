// Schema-domain diagnostics. The diagnostic constructors (`mkError`/`mkWarning`) are
// re-exported from `@keyma/core/util` so the schema frontend's call sites can keep
// importing them alongside the KEYMA#### codes from this module. The generic
// portable-lowering codes (KEYMA014, KEYMA080–087, KEYMA092) live in
// `@keyma/compiler/frontend-ts/diagnostics.ts` and are imported from there by the
// generic lowering that the schema frontend reuses.
//
// Codes are NEVER renumbered (see CLAUDE.md). These are the schema-domain codes; future
// schema codes continue in the historically-allocated 0xx–1xx bands. A future `@keyma/ui`
// domain takes its own reserved band (e.g. KEYMA0800+), and `@keyma/compiler` reserves
// KEYMA0200–0299 — so the three packages' future codes never collide.
export { mkError, mkWarning } from "@keyma/core/util";

// The generic portable-lowering codes are emitted by the compiler's lowering machinery the
// schema frontend reuses; re-exported here so a single `import * as CODES from
// "./diagnostics.js"` covers every code a schema-domain diagnostic might carry.
export {
    KEYMA010,
    KEYMA014,
    KEYMA024,
    KEYMA025,
    KEYMA050,
    KEYMA071,
    KEYMA080,
    KEYMA081,
    KEYMA082,
    KEYMA083,
    KEYMA084,
    KEYMA085,
    KEYMA086,
    KEYMA087,
    KEYMA092,
    KEYMA099,
} from "@keyma/compiler/frontend-ts";

// Schema-level structural errors
export const KEYMA001 = "KEYMA001"; // Duplicate schema name
export const KEYMA002 = "KEYMA002"; // Schema missing name

// Field-level errors
export const KEYMA011 = "KEYMA011"; // Non-literal decorator argument
export const KEYMA012 = "KEYMA012"; // Validator/formatter incompatible with field type
export const KEYMA013 = "KEYMA013"; // Missing required option on parameterized marker
export const KEYMA015 = "KEYMA015"; // (obsolete) Computed getter must have no setter — a getter/setter pair is now allowed (getter + setter accessor pair)
export const KEYMA018 = "KEYMA018"; // (obsolete) Computed getter dependency cycle — getters are now plain accessors (computed fields deferred), so no materialization order to cycle-check
export const KEYMA019 = "KEYMA019"; // @Computed applied to a non-getter (plain property)

// Validator / formatter errors
export const KEYMA020 = "KEYMA020"; // Unknown validator
export const KEYMA021 = "KEYMA021"; // Unknown formatter
export const KEYMA022 = "KEYMA022"; // Unknown custom validator (not registered)
export const KEYMA023 = "KEYMA023"; // Unknown custom formatter (not registered)

// Visibility and inheritance errors
export const KEYMA031 = "KEYMA031"; // Public schema leaks private schema
export const KEYMA032 = "KEYMA032"; // Public schema extends private parent
export const KEYMA033 = "KEYMA033"; // Child extends a non-@Schema-decorated class
export const KEYMA034 = "KEYMA034"; // Child field overrides parent with incompatible type
export const KEYMA035 = "KEYMA035"; // Persisted schema references an ephemeral schema via Reference<T>
export const KEYMA036 = "KEYMA036"; // Indexes declared on an ephemeral schema have no effect
export const KEYMA037 = "KEYMA037"; // Public schema has only private fields (no public surface)

// Index errors
export const KEYMA016 = "KEYMA016"; // Invalid @Indexed direction value (must be 1, -1, or "text")
export const KEYMA017 = "KEYMA017"; // Composite index key has conflicting unique/sparse across fields

// Naming and duplication errors
export const KEYMA040 = "KEYMA040"; // Duplicate member name (field, method, or setter)

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
export const KEYMA072 = "KEYMA072"; // Embedded<T> types form a cycle (inline data would be infinitely nested)

// Default value errors
export const KEYMA090 = "KEYMA090"; // Default initializer value incompatible with the field type
export const KEYMA091 = "KEYMA091"; // OBSOLETE — defaults are now property initializers; non-literal forms self-report via KEYMA082/085/086/087

// Service (remote function call) errors
export const KEYMA093 = "KEYMA093"; // Service method must be abstract (a signature with no body)
export const KEYMA094 = "KEYMA094"; // Duplicate method name within a service
export const KEYMA095 = "KEYMA095"; // @Service combined with @Schema/@Edge on the same class
export const KEYMA096 = "KEYMA096"; // Public service method exposes a private schema via a parameter/return type
export const KEYMA097 = "KEYMA097"; // Duplicate service name, or service name collides with a schema name

// Deferred-feature warnings
export const KEYMA098 = "KEYMA098"; // @Computed/@Indexed (etc.) on a getter is ignored — computed-field support is deferred; the getter is emitted as a plain accessor

// Binary tag manifest errors (assignTags pass — see binary serialization)
export const KEYMA100 = "KEYMA100"; // Field tag drift (suspected un-hinted rename) — re-run with --accept-tags, or add @RenamedFrom/@Tag
export const KEYMA101 = "KEYMA101"; // @RenamedFrom("old") names a field absent from the committed manifest
export const KEYMA102 = "KEYMA102"; // @Tag(n) invalid (must be a positive integer literal in range 1..2147483647)
export const KEYMA103 = "KEYMA103"; // Duplicate/reused tag within a schema (incl. reusing a tombstoned tag)

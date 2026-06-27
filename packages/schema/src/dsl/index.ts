// The schema-domain authoring surface. Re-exports the domain-neutral `@keyma/core/dsl`
// (semantic types and the neutral decorators @FormField/@Deprecated/@Service plus the
// binary-wire-tag field decorators @Tag/@RenamedFrom) and adds the schema-specific
// decorators (@Schema/@Edge/@Validate/@Format/…) plus the validator/formatter contract
// types, so a schema author imports everything from `@keyma/schema/dsl` with a single
// specifier.
export * from "@keyma/core/dsl";

// Validator/formatter authoring and contract types (schema-domain owned).
export type {
    ValidatorFn,
    FormatterFn,
    ValidationError,
    ValidatorContext,
    FormatterContext,
} from "./types.js";

// Schema-specific decorators
export {
    Schema,
    Indexed,
    Ephemeral,
    Computed,
    Edge,
    From,
    To,
    Validate,
    Format,
    Phase,
} from "./decorators.js";
export type {
    SchemaOptions,
    IndexOptions,
    EdgeOptions,
    FormatPhase,
} from "./decorators.js";

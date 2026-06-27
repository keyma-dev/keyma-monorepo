// Semantic types
export type {
    ID,
    DateOnly,
    DateTime,
    TimeOfDay,
    Decimal,
    Integer,
    Unsigned,
    Float,
    Json,
    Bytes,
    Nullable,
    Reference,
    Embedded,
} from "./types.js";

// Domain-neutral decorators. The schema-specific decorators — @Schema, @Edge, @Indexed,
// @From, @To, @Ephemeral, @Computed, @Tag, @RenamedFrom and the field-level @Validate /
// @Format (with their validator/formatter contract types) — live in `@keyma/schema/dsl`,
// which re-exports these alongside them.
export {
    FormField,
    Deprecated,
    Service,
} from "./decorators.js";
export type {
    FormFieldOptions,
    ServiceOptions,
} from "./decorators.js";

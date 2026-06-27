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

// Domain-neutral decorators (including the binary-wire-tag field decorators @Tag /
// @RenamedFrom, which apply to any serializable field). The schema-specific decorators —
// @Schema, @Edge, @Indexed, @From, @To, @Ephemeral, @Computed and the field-level
// @Validate / @Format (with their validator/formatter contract types) — live in
// `@keyma/schema/dsl`, which re-exports these alongside them.
export {
    FormField,
    Deprecated,
    Service,
    Tag,
    RenamedFrom,
} from "./decorators.js";
export type {
    FormFieldOptions,
    ServiceOptions,
} from "./decorators.js";

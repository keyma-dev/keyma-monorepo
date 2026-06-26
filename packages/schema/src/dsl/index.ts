// The schema-domain authoring surface. Re-exports the entire domain-neutral
// `@keyma/core/dsl` (semantic types, validator/formatter contracts, and the neutral
// decorators @Validate/@Format/@FormField/@Deprecated/@Service) and adds the
// schema-specific decorators, so a schema author imports everything from
// `@keyma/schema/dsl` with a single specifier.
export * from "@keyma/core/dsl";

// Schema-specific decorators
export {
    Schema,
    Indexed,
    Ephemeral,
    Computed,
    Tag,
    RenamedFrom,
    Edge,
    From,
    To,
} from "./decorators.js";
export type {
    SchemaOptions,
    IndexOptions,
    EdgeOptions,
} from "./decorators.js";

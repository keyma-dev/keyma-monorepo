import { Schema, Indexed } from "@keyma/schema/dsl";
import type { ID, DateTime } from "@keyma/schema/dsl";

/**
 * Wall-clock "now". A plain factory function — the compiler re-emits its body
 * into the generated bundle (`functions.js`) and references it from the schema's
 * `applyDefaults` for any field that defaults to `Now()`.
 */
export function Now(): DateTime {
    return new Date();
}

/**
 * Shared base for every persisted entity. Concrete schemas `extends Entity` and
 * inherit `id` + timestamps via the compiler's inheritance flattening — the
 * preferred way to share fields (abstract-class inheritance, static metadata).
 */
@Schema({ description: "Fields shared by every persisted entity." })
export abstract class Entity {
    @Indexed({ unique: true })
    declare readonly id: ID;

    /** Expression default — re-emitted as `applyDefaults` calling `Now()`. */
    createdAt: DateTime = Now();

    @Indexed({ direction: -1 })
    updatedAt: DateTime = Now();
}

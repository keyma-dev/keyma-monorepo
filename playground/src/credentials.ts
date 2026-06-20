import { Schema, Indexed, Computed } from "@keyma/dsl";
import type { Reference } from "@keyma/dsl";
import { Entity } from "./base.js";
import { Author } from "./author.js";

/**
 * A private schema: excluded from client bundles entirely. Demonstrates that a
 * private child may extend a public parent (the reverse — public extends private
 * — is a compile error, KEYMA032).
 */
@Schema({ name: "credentials", private: true, description: "Server-only auth material." })
export class Credentials extends Entity {

    @Indexed({ unique: true })
    declare author: Reference<Author>;

    declare passwordHash: string;

    // A computed, indexed field on a private schema.
    @Computed()
    @Indexed({ unique: true })
    get authorKey(): string {
        return this.author.id;
    }
}

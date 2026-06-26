import {
    Schema,
    Validate,
    Format,
    FormField,
    Indexed,
    Ephemeral,
    Phase,
} from "@keyma/schema/dsl";
import type {
    Reference,
    Embedded,
    DateOnly,
    TimeOfDay,
    Decimal,
    Json,
    Nullable,
} from "@keyma/schema/dsl";
import {
    minLength,
    maxLength,
    minItems,
    maxItems,
    hasUniqueItems,
    minDate,
    maxDate,
    min,
    max,
    multipleOf,
    isInteger,
    isNonNegative,
    isPositive,
    pattern,
} from "@keyma/schema/validators";
import { trim, titleCase, slugify, truncate } from "@keyma/schema/formatters";
import { Entity } from "./base.js";
import { Author } from "./author.js";

export enum PostStatus {
    Draft = "draft",
    Scheduled = "scheduled",
    Published = "published",
    Archived = "archived",
}

/** Inline, embedded sub-document — no `id` (it is stored inside its parent). */
@Schema({ name: "seo", description: "Embedded SEO metadata for a post." })
export class Seo {
    @Validate(maxLength(60))
    declare metaTitle: string;

    @Validate(maxLength(160))
    declare metaDescription?: string;
}

@Schema({ name: "post", description: "A blog post authored by an Author." })
export class Post extends Entity {

    // Composite index: `title` + `author` share the same `key`, forming one
    // compound index.
    @Validate(minLength(3), maxLength(120))
    @Format(Phase.Change, trim())
    @Format(Phase.Submit, titleCase())
    @Indexed({ key: "author_title" })
    @FormField({ title: "Title", group: "Content", order: 1 })
    declare title: string;

    @Format(Phase.Save, slugify())
    @Indexed({ unique: true })
    declare slug: string;

    // Full-text index.
    @Validate(minLength(1))
    @Format(Phase.Save, trim())
    @Indexed({ direction: "text" })
    @FormField({ title: "Body", group: "Content", order: 2 })
    declare body: string;

    @Validate(maxLength(200))
    @Format(Phase.Submit, truncate(200))
    declare excerpt?: string;

    status: PostStatus = PostStatus.Draft;

    // Array field + array validators.
    @Validate(minItems(0), maxItems(10), hasUniqueItems())
    declare tags: string[];

    // Foreign reference (stores the id only); other half of the composite index.
    @Indexed({ key: "author_title" })
    declare author: Reference<Author>;

    declare seo?: Embedded<Seo>;

    // Calendar date + date-range validators.
    @Validate(minDate("2000-01-01"), maxDate("2100-12-31"))
    declare publishedOn?: DateOnly;

    // Time-of-day.
    declare scheduledTime?: TimeOfDay;

    // Arbitrary-precision decimal — a string on the wire; validate its shape.
    @Validate(pattern("^[0-9]+(\\.[0-9]{1,2})?$"))
    declare price: Decimal;

    @Validate(min(0), max(5), multipleOf(0.5))
    rating: number = 0;

    @Validate(isInteger(), isNonNegative())
    views: number = 0;

    @Validate(isPositive())
    readingMinutes: number = 1;

    declare metadata?: Json;

    declare subtitle?: Nullable<string>;

    @Ephemeral()
    declare previewToken?: string;

    // A getter behavior (re-emitted as a class accessor, not a schema field).
    get summary(): string {
        return `${this.title} (${this.status})`;
    }
}

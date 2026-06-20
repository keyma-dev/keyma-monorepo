import { Schema, Validate, Format, Indexed, Phase } from "@keyma/dsl";
import { minLength, maxLength } from "@keyma/validators";
import { trim, slugify } from "@keyma/formatters";
import { Entity } from "./base.js";

@Schema({ name: "tag", description: "A label that posts can be related to." })
export class Tag extends Entity {

    @Validate(minLength(1), maxLength(30))
    @Format(Phase.Change, trim())
    declare label: string;

    @Format(Phase.Save, slugify())
    @Indexed({ unique: true })
    declare slug: string;
}

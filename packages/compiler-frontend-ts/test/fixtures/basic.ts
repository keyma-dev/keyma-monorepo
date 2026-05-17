import { Schema, Validate, Indexed, Format, isRequired, minLength, maxLength, isEmailAddress, trim } from "@keyma/dsl";
import type { ID } from "@keyma/dsl";

@Schema({ name: "user", description: "A platform user" })
class User {
    @Validate(isRequired)
    @Indexed({ unique: true })
    declare readonly id: ID;

    @Validate(isRequired, minLength(2), maxLength(64))
    @Format("change", trim)
    declare firstName: string;

    @Validate(isRequired, isEmailAddress, maxLength(255))
    @Indexed({ unique: true })
    declare email: string;

    declare age?: number;
}

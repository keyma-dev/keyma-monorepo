import { Schema, Validate, Indexed, Format } from "@keyma/dsl";
import type { ID } from "@keyma/dsl";

function isRequired() { return { __validatorName: "required" } as const; }
function minLength(value: number) { return { __validatorName: "minLength" as const, params: { value } }; }
function maxLength(value: number) { return { __validatorName: "maxLength" as const, params: { value } }; }
function isEmail() { return { __validatorName: "emailAddress" } as const; }
function trim() { return { __formatterName: "trim" } as const; }

@Schema({ name: "user", description: "A platform user" })
class User {
    @Validate(isRequired())
    @Indexed({ unique: true })
    declare readonly id: ID;

    @Validate(isRequired(), minLength(2), maxLength(64))
    @Format("change", trim())
    declare firstName: string;

    @Validate(isRequired(), isEmail(), maxLength(255))
    @Indexed({ unique: true })
    declare email: string;

    declare age?: number;
}

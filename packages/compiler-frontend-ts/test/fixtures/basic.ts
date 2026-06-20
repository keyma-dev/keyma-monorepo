import { Schema, Validate, Indexed, Format } from "@keyma/dsl";
import type { ID, ValidatorFn, FormatterFn, Json } from "@keyma/dsl";

function required(): ValidatorFn<Json> { return (value, field) => value !== null ? null : { field: field, code: "required", message: "required" }; }
function minLength(value: number): ValidatorFn<string> { return (raw, field) => raw.length < value ? { field: field, code: "minLength", message: "too short" } : null; }
function maxLength(value: number): ValidatorFn<string> { return (raw, field) => raw.length > value ? { field: field, code: "maxLength", message: "too long" } : null; }
function emailAddress(): ValidatorFn<string> { return (value, field) => value.includes("@") ? null : { field: field, code: "emailAddress", message: "invalid" }; }
function trim(): FormatterFn<string> { return (value) => value.trim(); }

@Schema({ name: "user", description: "A platform user" })
class User {
    @Validate(required())
    @Indexed({ unique: true })
    declare readonly id: ID;

    @Validate(required(), minLength(2), maxLength(64))
    @Format("change", trim())
    declare firstName: string;

    @Validate(required(), emailAddress(), maxLength(255))
    @Indexed({ unique: true })
    declare email: string;

    declare age?: number;
}

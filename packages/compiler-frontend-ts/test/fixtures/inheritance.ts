import { Schema, Validate } from "@keyma/dsl";
import type { ID } from "@keyma/dsl";

import type { ValidatorFn, Json } from "@keyma/dsl";
function required(): ValidatorFn<Json> { return (value, field) => value !== null ? null : { field: field, code: "required", message: "required" }; }

@Schema({ name: "person" })
class Person {
    @Validate(required())
    declare id: ID;

    @Validate(required())
    declare firstName: string;

    @Validate(required())
    declare lastName: string;
}

@Schema({ name: "employee" })
class Employee extends Person {
    @Validate(required())
    declare department: string;

    declare salary?: number;
}

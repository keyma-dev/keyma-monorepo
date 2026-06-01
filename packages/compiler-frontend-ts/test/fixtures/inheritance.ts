import { Schema, Validate } from "@keyma/dsl";
import type { ID } from "@keyma/dsl";

function isRequired() { return { __validatorName: "required" } as const; }

@Schema({ name: "person" })
class Person {
    @Validate(isRequired())
    declare id: ID;

    @Validate(isRequired())
    declare firstName: string;

    @Validate(isRequired())
    declare lastName: string;
}

@Schema({ name: "employee" })
class Employee extends Person {
    @Validate(isRequired())
    declare department: string;

    declare salary?: number;
}

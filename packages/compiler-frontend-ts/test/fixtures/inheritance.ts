import { Schema, Validate, isRequired } from "@keyma/dsl";
import type { ID } from "@keyma/dsl";

@Schema({ name: "person" })
class Person {
    @Validate(isRequired)
    declare id: ID;

    @Validate(isRequired)
    declare firstName: string;

    @Validate(isRequired)
    declare lastName: string;
}

@Schema({ name: "employee" })
class Employee extends Person {
    @Validate(isRequired)
    declare department: string;

    declare salary?: number;
}

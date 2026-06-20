import { Schema, Validate } from "@keyma/dsl";
import type { ID } from "@keyma/dsl";

import type { ValidatorFn, Json } from "@keyma/dsl";
function required(): ValidatorFn<Json> { return (value, field) => value !== null ? null : { field: field, code: "required", message: "required" }; }

@Schema({ name: "credentials", private: true })
class Credentials {
    @Validate(required())
    declare id: ID;

    @Validate(required())
    declare passwordHash: string;
}

@Schema({ name: "user" })
class User {
    @Validate(required())
    declare id: ID;

    declare private secretToken: string;

    @Validate(required())
    declare email: string;
}

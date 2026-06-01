import { Schema, Validate } from "@keyma/dsl";
import type { ID } from "@keyma/dsl";

function isRequired() { return { __validatorName: "required" } as const; }

@Schema({ name: "credentials", private: true })
class Credentials {
    @Validate(isRequired())
    declare id: ID;

    @Validate(isRequired())
    declare passwordHash: string;
}

@Schema({ name: "user" })
class User {
    @Validate(isRequired())
    declare id: ID;

    declare private secretToken: string;

    @Validate(isRequired())
    declare email: string;
}

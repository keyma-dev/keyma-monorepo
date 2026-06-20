import { Schema, Validate } from "@keyma/dsl";
import type { ID, Embedded } from "@keyma/dsl";

import type { ValidatorFn, Json } from "@keyma/dsl";
function required(): ValidatorFn<Json> { return (value, field) => value !== null ? null : { field: field, code: "required", message: "required" }; }

// An ephemeral schema: never persisted, used for wire payloads / function I/O.
@Schema({ name: "loginInput", ephemeral: true })
class LoginInput {
    @Validate(required())
    declare email: string;

    @Validate(required())
    declare password: string;
}

// A persisted schema. Embedding an ephemeral schema is allowed (data is inlined).
@Schema({ name: "auditEntry" })
class AuditEntry {
    @Validate(required())
    declare id: ID;

    declare attempt: Embedded<LoginInput>;
}

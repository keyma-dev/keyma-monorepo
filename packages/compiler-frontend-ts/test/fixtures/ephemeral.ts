import { Schema, Validate } from "@keyma/dsl";
import type { ID, Embedded } from "@keyma/dsl";

function isRequired() { return { __validatorName: "required" } as const; }

// An ephemeral schema: never persisted, used for wire payloads / function I/O.
@Schema({ name: "loginInput", ephemeral: true })
class LoginInput {
    @Validate(isRequired())
    declare email: string;

    @Validate(isRequired())
    declare password: string;
}

// A persisted schema. Embedding an ephemeral schema is allowed (data is inlined).
@Schema({ name: "auditEntry" })
class AuditEntry {
    @Validate(isRequired())
    declare id: ID;

    declare attempt: Embedded<LoginInput>;
}

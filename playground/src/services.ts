import { Schema, Service, Validate } from "@keyma/schema/dsl";
import type { ID, Json } from "@keyma/schema/dsl";
import { isEmail, minLength } from "@keyma/schema/validators";
import { matchesPassword } from "./lib/validators.js";

// ── Ephemeral wire payloads (never persisted) ────────────────────────────────

@Schema({ ephemeral: true, description: "Self-service signup payload." })
export class SignupInput {
    @Validate(isEmail())
    declare email: string;

    @Validate(minLength(8))
    declare password: string;

    // Cross-field validation: must equal `password` (see ctx.object usage).
    @Validate(matchesPassword())
    declare confirmPassword: string;
}

@Schema({ ephemeral: true })
export class SignupResult {
    declare id: ID;
    declare token: string;
}

@Schema({ ephemeral: true })
export class InviteInput {
    @Validate(isEmail())
    declare email: string;

    declare message?: string;
}

@Schema({ ephemeral: true })
export class InviteResult {
    declare id: ID;
    declare token: string;
}

// ── Services ─────────────────────────────────────────────────────────────────

/**
 * A public, remotely-callable service. Only signatures are compiled; the server
 * implements it by extending the generated abstract class and the client calls
 * it via `Keyma.call(AccountService, "signup", { input })`.
 */
@Service({ name: "AccountService", description: "Account lifecycle operations." })
export abstract class AccountService {
    abstract signup(input: SignupInput): SignupResult;
    abstract invite(input: InviteInput): InviteResult;
    abstract resend(email: string): boolean;
    abstract pending(): InviteResult[];
}

/** A private service — callable only by system identities. */
@Service({ private: true, description: "Privileged administrative operations." })
export abstract class AdminService {
    abstract purge(email: string): boolean;
    abstract stats(): Json;
}

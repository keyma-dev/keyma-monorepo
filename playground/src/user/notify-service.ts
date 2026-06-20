import { Schema, Service } from "@keyma/dsl";
import type { ID } from "@keyma/dsl";

// Ephemeral wire payloads for the service's input/output (never persisted).
@Schema({ ephemeral: true })
export class InviteInput {
    declare email: string;
    declare message?: string;
}

@Schema({ ephemeral: true })
export class InviteResult {
    declare id: ID;
    declare token: string;
}

// A remotely-callable service. Only the signatures are compiled; the server
// implements it by extending the generated abstract class, and the client calls
// it type-safely via `Keyma.call(NotifyService, "sendInvite", { input })`.
@Service()
export abstract class NotifyService {
    abstract sendInvite(input: InviteInput): InviteResult;
    abstract resend(email: string): boolean;
    abstract pending(): InviteResult[];
}

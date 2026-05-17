import type { AclAction } from "@keyma/runtime-js";

export type AclSubject =
    | { kind: "anon" }
    | { kind: "any-user" }
    | { kind: "user"; id: string }
    | { kind: "role"; name: string };

export type AclEffect = "allow" | "deny";

/** In-memory rule shape. Storage is flat (see schemas.ts) and decoded into this. */
export type AclRule = {
    id: string;
    subject: AclSubject;
    /** "*" matches any schema. */
    schema: string;
    actions: readonly AclAction[];
    /** Filter merged into the operation's `where`. May use "$self" and
     *  "$ctx.path.to.value" placeholders. Restricted to top-level fields of the
     *  operating schema in v1 — joins/populated paths are not evaluated. */
    where?: Record<string, unknown>;
    fields?: {
        /** Allowed read fields. `undefined` = all non-private. */
        read?: readonly string[];
        /** Allowed write fields. `undefined` = all writable. */
        write?: readonly string[];
    };
    effect?: AclEffect;
    /** Reserved; ignored in v1. */
    priority?: number;
};

export type AclPluginOptions = {
    /** Optional override. Defaults to the host server's adapter. */
    adapter?: import("@keyma/runtime-js").KeymaDatabaseAdapter;
    /** Silent-strip disallowed write fields instead of throwing FIELD_FORBIDDEN. */
    stripWrites?: boolean;
    /** If true, ACL-stripped reads return null with a structured FORBIDDEN
     *  error instead of NOT_FOUND. v1 default is false (don't leak existence). */
    leakExistence?: boolean;
    /** Optional logger for plugin-level diagnostics (rule load failures, etc.). */
    logger?: (level: "warn" | "error", message: string, details?: unknown) => void;
};

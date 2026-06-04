/** The ACL action vocabulary. Read-side operations (`list`, `read`, `traverse`)
 *  are consolidated into a single `read` grant — see `normalizeAction` in
 *  rule-loader.ts. Writes keep their distinct actions. */
export type AclAction = "read" | "create" | "update" | "delete";

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
    /** Granted actions. Read-side ops (list/read/traverse) all match `read`. */
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
    /** Silent-strip disallowed write fields instead of throwing FIELD_FORBIDDEN. */
    stripWrites?: boolean;
    /** If true, ACL-stripped reads return null with a structured FORBIDDEN
     *  error instead of NOT_FOUND. v1 default is false (don't leak existence). */
    leakExistence?: boolean;
    /** Optional logger for plugin-level diagnostics (rule load failures, etc.). */
    logger?: (level: "warn" | "error", message: string, details?: unknown) => void;
};

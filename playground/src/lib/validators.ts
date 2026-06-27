import type { ValidatorFn } from "@keyma/schema/dsl";

/**
 * Cross-field validator: the value must equal the record's `password` field.
 * Uses the 3rd (context) parameter — `ctx.object` is the whole record. Object
 * literals must use explicit `key: value` pairs to stay portable.
 */
export function matchesPassword(): ValidatorFn<string> {
    return (value, field, ctx) =>
        value === ctx.object.password
            ? null
            : { field: field, code: "password_mismatch", message: "passwords must match" };
}

/** Reject a small blocklist of reserved handles. */
export function notReserved(): ValidatorFn<string> {
    return (value, field) =>
        value === "admin" || value === "root" || value === "system"
            ? { field: field, code: "reserved", message: `"${value}" is reserved` }
            : null;
}

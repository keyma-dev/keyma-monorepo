import type { SchemaMetadata } from "@keyma/runtime-js";

// ── Storage schemas ─────────────────────────────────────────────────────────
//
// Rules are stored in a flat shape — discriminated `subject` is decomposed into
// `subjectKind` + `subjectId` + `subjectRole`, and the `where` / `fields`
// objects are stored as JSON. The plugin re-hydrates these into `AclRule`
// values via `decodeRule()` (see rule-loader.ts).

export const ACL_RULE_SCHEMA_NAME = "keymaAclRule";
export const ACL_ROLE_SCHEMA_NAME = "keymaAclRole";
export const ACL_ROLE_ASSIGNMENT_SCHEMA_NAME = "keymaAclRoleAssignment";

export const ACL_RULE_SCHEMA: SchemaMetadata = {
    name: ACL_RULE_SCHEMA_NAME,
    sourceName: "KeymaAclRule",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true, validators: [{ kind: "required" }] },
        {
            name: "subjectKind",
            type: { kind: "string" },
            validators: [
                { kind: "required" },
                { kind: "oneOf", values: ["anon", "any-user", "user", "role"] },
            ],
        },
        { name: "subjectId", type: { kind: "string" }, required: false },
        { name: "subjectRole", type: { kind: "string" }, required: false },
        {
            name: "schema",
            type: { kind: "string" },
            validators: [{ kind: "required" }],
        },
        {
            name: "actions",
            type: { kind: "array", of: { kind: "string" } },
            validators: [{ kind: "required" }, { kind: "minItems", value: 1 }],
        },
        { name: "where", type: { kind: "json" }, required: false },
        { name: "fieldsRead", type: { kind: "array", of: { kind: "string" } }, required: false },
        { name: "fieldsWrite", type: { kind: "array", of: { kind: "string" } }, required: false },
        {
            name: "effect",
            type: { kind: "string" },
            required: false,
            validators: [{ kind: "oneOf", values: ["allow", "deny"] }],
        },
        { name: "priority", type: { kind: "integer" }, required: false },
    ],
    indexes: [
        { fields: [{ name: "subjectKind", direction: 1 }, { name: "schema", direction: 1 }] },
        { fields: [{ name: "subjectId", direction: 1 }] },
        { fields: [{ name: "subjectRole", direction: 1 }] },
    ],
};

export const ACL_ROLE_SCHEMA: SchemaMetadata = {
    name: ACL_ROLE_SCHEMA_NAME,
    sourceName: "KeymaAclRole",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true, validators: [{ kind: "required" }] },
        { name: "name", type: { kind: "string" }, validators: [{ kind: "required" }] },
    ],
    indexes: [{ fields: [{ name: "name", direction: 1 }], unique: true }],
};

export const ACL_ROLE_ASSIGNMENT_SCHEMA: SchemaMetadata = {
    name: ACL_ROLE_ASSIGNMENT_SCHEMA_NAME,
    sourceName: "KeymaAclRoleAssignment",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true, validators: [{ kind: "required" }] },
        { name: "userId", type: { kind: "string" }, validators: [{ kind: "required" }] },
        { name: "role", type: { kind: "string" }, validators: [{ kind: "required" }] },
    ],
    indexes: [
        { fields: [{ name: "userId", direction: 1 }] },
        { fields: [{ name: "role", direction: 1 }] },
    ],
};

/** Internal list of all ACL storage schemas. The plugin registers these with
 *  the adapter during `init()` — the host must NOT register them on its own
 *  `KeymaServer` (rule, role, and role-assignment storage is private). */
export const aclSchemas: readonly SchemaMetadata[] = [
    ACL_RULE_SCHEMA,
    ACL_ROLE_SCHEMA,
    ACL_ROLE_ASSIGNMENT_SCHEMA,
];

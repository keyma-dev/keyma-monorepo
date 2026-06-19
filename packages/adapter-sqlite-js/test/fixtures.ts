import type { SchemaMetadata } from "@keyma/runtime-js";

/** Deterministic 24-char hex id from a small integer (matches the Mongo
 *  adapter fixtures' shape so cross-adapter comparisons stay readable). */
function id(n: number): string {
    return n.toString(16).padStart(24, "0");
}

export const IDS = {
    u1: id(1), u2: id(2), u3: id(3), u4: id(4),
    alice: id(10), bob: id(11),
    a: id(20), b: id(21), c: id(22), d: id(23), e: id(24),
    o1: id(30), o2: id(31),
    p1: id(40), p2: id(41), p3: id(42),
    tech: id(50), news: id(51),
    a1: id(60), a2: id(61), a3: id(62),
    t1: id(70), t2: id(71), t3: id(72),
    f1: id(80), f2: id(81), f3: id(82), f4: id(83),
} as const;

export const ORG_SCHEMA: SchemaMetadata = {
    name: "organization",
    sourceName: "Organization",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "name", type: { kind: "string" } },
        { name: "tier", type: { kind: "string" }, required: false },
    ],
};

export const USER_SCHEMA: SchemaMetadata = {
    name: "user",
    sourceName: "User",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "email", type: { kind: "string" }, indexes: [{ unique: true }] },
        { name: "name", type: { kind: "string" } },
        { name: "age", type: { kind: "integer" }, required: false },
        { name: "active", type: { kind: "boolean" }, required: false },
        {
            name: "organization",
            type: { kind: "reference", schema: "organization" },
            nullable: true,
            required: false,
        },
        { name: "tags", type: { kind: "array", of: { kind: "string" } }, required: false },
    ],
    indexes: [
        { fields: [{ name: "name", direction: 1 }] },
    ],
};

export const POST_SCHEMA: SchemaMetadata = {
    name: "post",
    sourceName: "Post",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "title", type: { kind: "string" } },
    ],
};

export const TAG_SCHEMA: SchemaMetadata = {
    name: "tag",
    sourceName: "Tag",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "label", type: { kind: "string" } },
    ],
};

export const AUTHORSHIP_SCHEMA: SchemaMetadata = {
    name: "authorship",
    sourceName: "Authorship",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "author", type: { kind: "reference", schema: "user" }, indexes: [{}] },
        { name: "post", type: { kind: "reference", schema: "post" }, indexes: [{}] },
    ],
    edge: {
        from: "User", fromField: "author",
        to: "Post", toField: "post",
        label: "wrote", directed: true,
    },
};

export const TAGGING_SCHEMA: SchemaMetadata = {
    name: "tagging",
    sourceName: "Tagging",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "post", type: { kind: "reference", schema: "post" }, indexes: [{}] },
        { name: "tag", type: { kind: "reference", schema: "tag" }, indexes: [{}] },
    ],
    edge: {
        from: "Post", fromField: "post",
        to: "Tag", toField: "tag",
        label: "tagged", directed: true,
    },
};

export const FRIENDSHIP_SCHEMA: SchemaMetadata = {
    name: "friendship",
    sourceName: "Friendship",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "userA", type: { kind: "reference", schema: "user" }, indexes: [{}] },
        { name: "userB", type: { kind: "reference", schema: "user" }, indexes: [{}] },
    ],
    edge: {
        from: "User", fromField: "userA",
        to: "User", toField: "userB",
        label: "friend", directed: false,
    },
};

export const ALL_SCHEMAS: readonly SchemaMetadata[] = [
    ORG_SCHEMA, USER_SCHEMA, POST_SCHEMA, TAG_SCHEMA,
    AUTHORSHIP_SCHEMA, TAGGING_SCHEMA, FRIENDSHIP_SCHEMA,
];

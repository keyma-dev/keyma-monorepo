import type { SchemaMetadata } from "@keyma/runtime-js";

/** Plain string ids — Gremlin stores them as the element's `T.id`. */
export const IDS = {
    u1: "u1", u2: "u2", u3: "u3", u4: "u4",
    alice: "alice", bob: "bob",
    a: "a", b: "b", c: "c", d: "d", e: "e",
    o1: "o1",
    p1: "p1", p2: "p2", p3: "p3",
    tech: "tech", news: "news",
    a1: "a1", a2: "a2", a3: "a3",
    t1: "t1", t2: "t2", t3: "t3",
    f1: "f1", f2: "f2", f3: "f3", f4: "f4",
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

export const ADDRESS_SCHEMA: SchemaMetadata = {
    name: "address",
    sourceName: "Address",
    fields: [
        { name: "line1", type: { kind: "string" } },
        { name: "city", type: { kind: "string" } },
        { name: "postalCode", type: { kind: "string" }, required: false },
    ],
};

export const USER_SCHEMA: SchemaMetadata = {
    name: "user",
    sourceName: "User",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true, indexes: [{ unique: true }] },
        { name: "email", type: { kind: "string" }, indexes: [{ unique: true }] },
        { name: "name", type: { kind: "string" } },
        { name: "age", type: { kind: "integer" }, required: false },
        { name: "balance", type: { kind: "decimal" }, required: false },
        { name: "score", type: { kind: "bigint" }, required: false },
        { name: "avatar", type: { kind: "bytes" }, required: false },
        { name: "createdAt", type: { kind: "dateTime" }, required: false },
        {
            name: "organization",
            type: { kind: "reference", schema: "organization" },
            required: false,
        },
        { name: "address", type: { kind: "embedded", schema: "address" }, required: false },
        { name: "tags", type: { kind: "array", of: { kind: "string" } }, required: false },
        { name: "manager", type: { kind: "reference", schema: "user" }, required: false },
        { name: "tagIds", type: { kind: "array", of: { kind: "reference", schema: "tag" } }, required: false },
    ],
    indexes: [
        { fields: [{ name: "name", direction: 1 }, { name: "age", direction: -1 }] },
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

export const FRIENDSHIP_SCHEMA: SchemaMetadata = {
    name: "friendship",
    sourceName: "Friendship",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "userA", type: { kind: "reference", schema: "user" }, indexes: [{}] },
        { name: "userB", type: { kind: "reference", schema: "user" }, indexes: [{}] },
        { name: "since", type: { kind: "string" }, required: false },
    ],
    edge: { from: "User", fromField: "userA", to: "User", toField: "userB", label: "friend", directed: false },
};

export const AUTHORSHIP_SCHEMA: SchemaMetadata = {
    name: "authorship",
    sourceName: "Authorship",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "author", type: { kind: "reference", schema: "user" }, indexes: [{}] },
        { name: "post", type: { kind: "reference", schema: "post" }, indexes: [{}] },
    ],
    edge: { from: "User", fromField: "author", to: "Post", toField: "post", label: "wrote", directed: true },
};

export const TAGGING_SCHEMA: SchemaMetadata = {
    name: "tagging",
    sourceName: "Tagging",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "post", type: { kind: "reference", schema: "post" }, indexes: [{}] },
        { name: "tag", type: { kind: "reference", schema: "tag" }, indexes: [{}] },
    ],
    edge: { from: "Post", fromField: "post", to: "Tag", toField: "tag", label: "tagged", directed: true },
};

export function schemaMap(...schemas: SchemaMetadata[]): Map<string, SchemaMetadata> {
    return new Map(schemas.map((s) => [s.name, s]));
}

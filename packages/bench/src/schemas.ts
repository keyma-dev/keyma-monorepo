import type { SchemaMetadata } from "@keyma/runtime/schema";

export const ORG_SCHEMA: SchemaMetadata = {
    name: "benchOrg",
    sourceName: "BenchOrg",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "name", type: { kind: "string" } },
    ],
};

export const USER_SCHEMA: SchemaMetadata = {
    name: "benchUser",
    sourceName: "BenchUser",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true, indexes: [{ unique: true }] },
        { name: "email", type: { kind: "string" }, indexes: [{ unique: true }] },
        { name: "name", type: { kind: "string" } },
        { name: "age", type: { kind: "integer" }, required: false },
        { name: "organization", type: { kind: "reference", schema: "benchOrg" }, required: false },
    ],
    indexes: [
        { fields: [{ name: "name", direction: 1 }] },
    ],
};

export const POST_SCHEMA: SchemaMetadata = {
    name: "benchPost",
    sourceName: "BenchPost",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "title", type: { kind: "string" } },
    ],
};

export const TAG_SCHEMA: SchemaMetadata = {
    name: "benchTag",
    sourceName: "BenchTag",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "label", type: { kind: "string" } },
    ],
};

export const AUTHORSHIP_SCHEMA: SchemaMetadata = {
    name: "benchAuthorship",
    sourceName: "BenchAuthorship",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "author", type: { kind: "reference", schema: "benchUser" }, indexes: [{}] },
        { name: "post", type: { kind: "reference", schema: "benchPost" }, indexes: [{}] },
    ],
    edge: {
        from: "BenchUser",
        fromField: "author",
        to: "BenchPost",
        toField: "post",
        label: "wrote",
        directed: true,
    },
};

export const TAGGING_SCHEMA: SchemaMetadata = {
    name: "benchTagging",
    sourceName: "BenchTagging",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "post", type: { kind: "reference", schema: "benchPost" }, indexes: [{}] },
        { name: "tag", type: { kind: "reference", schema: "benchTag" }, indexes: [{}] },
    ],
    edge: {
        from: "BenchPost",
        fromField: "post",
        to: "BenchTag",
        toField: "tag",
        label: "tagged",
        directed: true,
    },
};

export const FRIENDSHIP_SCHEMA: SchemaMetadata = {
    name: "benchFriendship",
    sourceName: "BenchFriendship",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "userA", type: { kind: "reference", schema: "benchUser" }, indexes: [{}] },
        { name: "userB", type: { kind: "reference", schema: "benchUser" }, indexes: [{}] },
    ],
    edge: {
        from: "BenchUser",
        fromField: "userA",
        to: "BenchUser",
        toField: "userB",
        label: "friend",
        directed: false,
    },
};

export const ALL_SCHEMAS: readonly SchemaMetadata[] = [
    ORG_SCHEMA,
    USER_SCHEMA,
    POST_SCHEMA,
    TAG_SCHEMA,
    AUTHORSHIP_SCHEMA,
    TAGGING_SCHEMA,
    FRIENDSHIP_SCHEMA,
];

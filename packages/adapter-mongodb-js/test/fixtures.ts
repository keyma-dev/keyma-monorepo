import type { SchemaMetadata } from "@keyma/runtime-js";

/** Generate a valid 24-char ObjectId hex string from a small integer. */
function mkoid(n: number): string {
    return n.toString(16).padStart(24, "0");
}

/** Named ObjectId strings for use across test files. */
export const OIDS = {
    // generic users (adapter / index / populate tests)
    u1: mkoid(1),
    u2: mkoid(2),
    u3: mkoid(3),
    u4: mkoid(4),
    // traverse: named users
    alice: mkoid(10),
    bob:   mkoid(11),
    a:     mkoid(20),
    b:     mkoid(21),
    c:     mkoid(22),
    d:     mkoid(23),
    e:     mkoid(24),
    // orgs
    o1: mkoid(30),
    // posts
    p1: mkoid(40),
    p2: mkoid(41),
    p3: mkoid(42),
    // tags
    tech: mkoid(50),
    news: mkoid(51),
    // authorship edges
    a1: mkoid(60),
    a2: mkoid(61),
    a3: mkoid(62),
    // tagging edges
    t1: mkoid(70),
    t2: mkoid(71),
    t3: mkoid(72),
    // friendship edges
    f1: mkoid(80),
    f2: mkoid(81),
    f3: mkoid(82),
    f4: mkoid(83),
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
        {
            name: "id",
            type: { kind: "id" },
            readonly: true,
            indexes: [{ unique: true }],
        },
        {
            name: "email",
            type: { kind: "string" },
            indexes: [{ unique: true, key: "user_email_uniq" }],
        },
        { name: "name", type: { kind: "string" } },
        { name: "age", type: { kind: "integer" }, required: false },
        { name: "balance", type: { kind: "decimal" }, required: false },
        { name: "score", type: { kind: "bigint" }, required: false },
        { name: "avatar", type: { kind: "bytes" }, required: false },
        { name: "birthday", type: { kind: "string" }, required: false },
        { name: "createdAt", type: { kind: "dateTime" }, required: false },
        {
            name: "organization",
            type: { kind: "reference", schema: "organization" },
            required: false,
        },
        {
            name: "address",
            type: { kind: "embedded", schema: "address" },
            required: false,
        },
        { name: "tags", type: { kind: "array", of: { kind: "string" } }, required: false },
    ],
    indexes: [
        { fields: [{ name: "name", direction: 1 }, { name: "age", direction: -1 }] },
    ],
};

// Edges for traverse tests
export const FRIENDSHIP_SCHEMA: SchemaMetadata = {
    name: "friendship",
    sourceName: "Friendship",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "userA", type: { kind: "reference", schema: "user" }, indexes: [{}] },
        { name: "userB", type: { kind: "reference", schema: "user" }, indexes: [{}] },
        { name: "since", type: { kind: "string" }, required: false },
    ],
    edge: {
        from: "User",
        fromField: "userA",
        to: "User",
        toField: "userB",
        label: "friend",
        directed: false,
    },
};

export const POST_SCHEMA: SchemaMetadata = {
    name: "post",
    sourceName: "Post",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "title", type: { kind: "string" } },
    ],
    indexes: [
        { fields: [{ name: "title", direction: 1 }] },
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
        from: "User",
        fromField: "author",
        to: "Post",
        toField: "post",
        label: "wrote",
        directed: true,
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
        from: "Post",
        fromField: "post",
        to: "Tag",
        toField: "tag",
        label: "tagged",
        directed: true,
    },
};

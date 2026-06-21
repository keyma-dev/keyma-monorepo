/**
 * Asserts the *shape* of the generated metadata — proving each DSL feature
 * lowered correctly into the emitted server/client bundles.
 *
 * Server classes come through the shared setup; client classes are imported
 * directly from the client bundle so we can compare visibility/defaults.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    Author,
    Post,
    Follows,
    Related,
    AccountService,
    AdminService,
} from "./setup.ts";

import * as client from "../dist/js/client/index.js";
import { Author as ClientAuthor } from "../dist/js/client/index.js";

type Field = {
    name: string;
    type: { kind: string; [k: string]: unknown };
    required?: boolean;
    nullable?: boolean;
    validators?: unknown[];
    formatters?: { phase: string; fn?: unknown }[];
    indexes?: Record<string, unknown>[];
    computed?: boolean;
    ephemeral?: boolean;
    deprecated?: string | boolean;
    visibility?: string;
    form?: Record<string, unknown>;
};

function field(schema: { fields: Field[] }, name: string): Field {
    const f = schema.fields.find((x) => x.name === name);
    assert.ok(f, `field "${name}" exists`);
    return f as Field;
}

describe("metadata — inheritance", () => {
    it("Author inherits id/createdAt/updatedAt from Entity", () => {
        const names = Author.schema.fields.map((f: Field) => f.name);
        assert.ok(names.includes("id"), "has inherited id");
        assert.ok(names.includes("createdAt"), "has inherited createdAt");
        assert.ok(names.includes("updatedAt"), "has inherited updatedAt");
    });

    it("Author schema name/sourceName", () => {
        assert.equal(Author.schema.name, "author");
        assert.equal(Author.schema.sourceName, "Author");
    });
});

describe("metadata — Author field metadata", () => {
    it("email has validators, multi-phase formatters and form metadata", () => {
        const email = field(Author.schema, "email");

        assert.ok(Array.isArray(email.validators));
        assert.ok(email.validators!.length > 0, "non-empty validators array");
        assert.ok(
            email.validators!.every((v) => typeof v === "function"),
            "validators are function references",
        );

        const phases = (email.formatters ?? []).map((f) => f.phase);
        assert.ok(phases.includes("change"));
        assert.ok(phases.includes("blur"));
        assert.ok(phases.includes("save"));
        assert.ok(
            (email.formatters ?? []).every((f) => typeof f.fn === "function"),
            "each formatter carries a fn reference",
        );

        assert.deepEqual(email.form, {
            title: "Email",
            hint: "We never share this.",
            placeholder: "you@example.com",
            group: "Account",
            order: 1,
        });
    });

    it("homepage carries the deprecation message", () => {
        assert.equal(
            field(Author.schema, "homepage").deprecated,
            "Use `website` instead.",
        );
    });

    it("avatar lowers to the bytes type", () => {
        assert.deepEqual(field(Author.schema, "avatar").type, { kind: "bytes" });
    });

    it("username is nullable with a unique+sparse index", () => {
        const username = field(Author.schema, "username");
        assert.equal(username.nullable, true);
        assert.ok(Array.isArray(username.indexes));
        assert.ok(
            username.indexes!.some(
                (idx) => idx.unique === true && idx.sparse === true,
            ),
            "has a unique+sparse index entry",
        );
    });

    it("role lowers to an enum with the declared values", () => {
        const role = field(Author.schema, "role");
        assert.equal(role.type.kind, "enum");
        assert.deepEqual(role.type.values, ["owner", "editor", "viewer"]);
    });

    it("securityStamp is marked private", () => {
        assert.equal(field(Author.schema, "securityStamp").visibility, "private");
    });
});

describe("metadata — Post field/index metadata", () => {
    it("has the author_title composite index over title and author", () => {
        const indexes = (Post.schema as { indexes?: { name?: string; fields: { name: string }[] }[] })
            .indexes;
        assert.ok(Array.isArray(indexes), "Post has composite indexes");
        const composite = indexes!.find((i) => i.name === "author_title");
        assert.ok(composite, "author_title composite index exists");
        const fieldNames = composite!.fields.map((f) => f.name);
        assert.deepEqual(fieldNames, ["title", "author"]);
    });

    it("body has a text index", () => {
        const body = field(Post.schema, "body");
        assert.ok(Array.isArray(body.indexes));
        assert.ok(
            body.indexes!.some((idx) => idx.direction === "text"),
            "body has a text-direction index",
        );
    });

    it("slug has a unique index", () => {
        const slug = field(Post.schema, "slug");
        assert.ok(Array.isArray(slug.indexes));
        assert.ok(slug.indexes!.some((idx) => idx.unique === true));
    });

    it("semantic types lower to their IR kinds", () => {
        assert.equal(field(Post.schema, "tags").type.kind, "array");
        assert.equal(field(Post.schema, "price").type.kind, "decimal");
        assert.equal(field(Post.schema, "publishedOn").type.kind, "date");
        assert.equal(field(Post.schema, "scheduledTime").type.kind, "time");
        assert.equal(field(Post.schema, "permalink").type.kind, "regexp");
    });

    it("subtitle is nullable, previewToken is ephemeral, summary is computed", () => {
        assert.equal(field(Post.schema, "subtitle").nullable, true);
        assert.equal(field(Post.schema, "previewToken").ephemeral, true);
        assert.equal(field(Post.schema, "summary").computed, true);
    });
});

describe("metadata — edges", () => {
    it("Follows is a directed edge with the right endpoints", () => {
        const edge = (Follows.schema as { edge: Record<string, unknown> }).edge;
        assert.equal(edge.directed, true);
        assert.equal(edge.from, "author");
        assert.equal(edge.fromField, "follower");
        assert.equal(edge.to, "author");
        assert.equal(edge.toField, "following");
        assert.equal(edge.label, "FOLLOWS");
    });

    it("Related is an undirected edge with the right endpoints", () => {
        const edge = (Related.schema as { edge: Record<string, unknown> }).edge;
        assert.equal(edge.directed, false);
        assert.equal(edge.from, "post");
        assert.equal(edge.fromField, "post");
        assert.equal(edge.to, "tag");
        assert.equal(edge.toField, "tag");
        assert.equal(edge.label, "RELATED");
    });
});

describe("metadata — services", () => {
    it("AccountService methods lower with return schemas/arrays", () => {
        const svc = (AccountService as { service: { name: string; methods: { name: string; returnSchema?: string; returnArray?: boolean }[] } })
            .service;
        assert.equal(svc.name, "AccountService");

        const signup = svc.methods.find((m) => m.name === "signup");
        assert.ok(signup, "signup method exists");
        assert.equal(signup!.returnSchema, "signupresult");

        const pending = svc.methods.find((m) => m.name === "pending");
        assert.ok(pending, "pending method exists");
        assert.equal(pending!.returnArray, true);
    });

    it("AdminService is private", () => {
        const svc = (AdminService as { service: { visibility?: string } }).service;
        assert.equal(svc.visibility, "private");
    });
});

describe("metadata — client vs server visibility", () => {
    it("client bundle omits private schemas/services", () => {
        assert.equal((client as any)["Credentials"], undefined, "Credentials not exported to client");
        assert.equal((client as any)["AdminService"], undefined, "AdminService not exported to client");
        // sanity: public ones are present
        assert.equal(typeof client.Author, "function");
        assert.equal(typeof client.AccountService, "function");
    });

    it("client Author omits defaults; server Author keeps them", () => {
        assert.equal(ClientAuthor.schema.applyDefaults, undefined);
        assert.equal(typeof Author.schema.applyDefaults, "function");
    });

    it("client Author strips the private securityStamp field", () => {
        const clientNames = ClientAuthor.schema.fields.map((f: Field) => f.name);
        const serverNames = Author.schema.fields.map((f: Field) => f.name);
        assert.ok(!clientNames.includes("securityStamp"), "client strips securityStamp");
        assert.ok(serverNames.includes("securityStamp"), "server keeps securityStamp");
    });
});

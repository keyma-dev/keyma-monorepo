import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual } from "../src/compile.js";
import type { IRType } from "@keyma/ir";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VIRTUAL_BASE = path.join(__dirname, "..", "..", "src");

/** A small project exercising every identity surface: a reference target, an
 *  edge with two endpoints, and a service whose method references a schema. */
const SOURCES: Record<string, string> = {
    "models.ts": `
        import { Schema, Edge, From, To } from "@keyma/dsl";
        import type { ID, Reference } from "@keyma/dsl";

        @Schema() export class User { declare readonly id: ID; declare name: string; }
        @Schema() export class Post {
            declare readonly id: ID;
            declare author: Reference<User>;
        }
        @Edge() export class Wrote {
            declare readonly id: ID;
            @From() declare from: Reference<User>;
            @To() declare to: Reference<Post>;
        }
    `,
    "service.ts": `
        import { Service } from "@keyma/dsl";
        import type { Reference } from "@keyma/dsl";
        import { User } from "./models.js";
        @Service() export abstract class Users {
            abstract get(id: string): Promise<Reference<User>>;
        }
    `,
};

function compileWith(schemaPrefix: string) {
    return compileVirtual(SOURCES, { baseDir: VIRTUAL_BASE, schemaPrefix });
}

/** sourceName → schema (the class name is stable regardless of prefix). */
function bySourceName(result: ReturnType<typeof compileWith>, sourceName: string) {
    const s = result.ir.schemas.find((x) => x.sourceName === sourceName);
    assert.ok(s !== undefined, `schema ${sourceName} not found`);
    return s;
}

/** Reference/embedded target name of a field's (possibly array) type. */
function refTarget(type: IRType): string | undefined {
    const inner = type.kind === "array" ? type.of : type;
    return inner.kind === "reference" || inner.kind === "embedded" ? inner.schema : undefined;
}

describe("schemaPrefix — name normalization", () => {
    it("with no prefix, references resolve to the bare (default) name", () => {
        const r = compileWith("");
        assert.deepEqual(r.diagnostics.filter((d) => d.severity === "error"), []);

        const post = bySourceName(r, "Post");
        assert.equal(post.name, "post");
        // The reference target is the canonical `name`, not the class name `User`.
        assert.equal(refTarget(post.fields.find((f) => f.name === "author")!.type), "user");

        const wrote = bySourceName(r, "Wrote");
        assert.equal(wrote.edge?.from, "user");
        assert.equal(wrote.edge?.to, "post");
        assert.equal(wrote.edge?.label, "wrote");

        // Service names default to the class name verbatim (not lowercased).
        const svc = r.ir.services?.find((s) => s.sourceName === "Users");
        assert.equal(svc?.name, "Users");
        assert.equal(refTarget(svc!.methods[0]!.returnType!), "user");
    });

    it("applies the prefix to every schema/service name AND every reference target", () => {
        const r = compileWith("blog_");
        assert.deepEqual(r.diagnostics.filter((d) => d.severity === "error"), []);

        // Schema identities carry the prefix; class names (sourceName) do not.
        const user = bySourceName(r, "User");
        assert.equal(user.name, "blog_user");
        assert.equal(user.sourceName, "User");
        assert.equal(user.id, "schema:blog_user");

        // Reference target is rewritten to the prefixed name of its target.
        const post = bySourceName(r, "Post");
        assert.equal(post.name, "blog_post");
        assert.equal(refTarget(post.fields.find((f) => f.name === "author")!.type), "blog_user");

        // Edge endpoints + label are all prefixed names.
        const wrote = bySourceName(r, "Wrote");
        assert.equal(wrote.edge?.from, "blog_user");
        assert.equal(wrote.edge?.to, "blog_post");
        assert.equal(wrote.edge?.label, "blog_wrote");

        // Services + their param/return schema references are prefixed too.
        const svc = r.ir.services?.find((s) => s.sourceName === "Users");
        assert.equal(svc?.name, "blog_Users");
        assert.equal(svc?.id, "service:blog_Users");
        assert.equal(refTarget(svc!.methods[0]!.returnType!), "blog_user");
    });
});

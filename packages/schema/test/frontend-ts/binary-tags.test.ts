import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual } from "./harness.js";
import type { TagManifest } from "@keyma/core/ir";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIRTUAL_BASE = path.join(__dirname, "..", "..", "..", "src", "frontend-ts");

function cv(source: string, extra: Record<string, unknown> = {}) {
    return compileVirtual({ "binmodel.ts": source }, { baseDir: VIRTUAL_BASE, ...extra });
}

function tagsOf(result: ReturnType<typeof cv>, sourceName: string): Record<string, number | undefined> {
    const s = result.ir.schemas.find((x) => x.sourceName === sourceName)!;
    const o: Record<string, number | undefined> = {};
    for (const f of s.fields) o[f.name] = f.tag;
    return o;
}
const errorCodes = (r: ReturnType<typeof cv>) => r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);

const USER = `
import { Schema } from "@keyma/schema/dsl";
import type { ID } from "@keyma/schema/dsl";

@Schema()
export class User {
    id!: ID;
    email!: string;
    name!: string;
}
`;

describe("binary tag assignment (end to end)", () => {
    it("assigns declaration-index tags and bumps irVersion when binary is enabled", () => {
        const r = cv(USER, { binaryTags: true });
        assert.deepEqual(errorCodes(r), []);
        assert.deepEqual(tagsOf(r, "User"), { id: 1, email: 2, name: 3 });
        assert.equal(r.ir.irVersion, "9.1.0");
        assert.equal(r.tagManifest!.schemas["user"]!.fields["email"], 2);
    });

    it("emits NO tags and leaves irVersion untouched when binary is disabled", () => {
        const r = cv(USER);
        assert.deepEqual(tagsOf(r, "User"), { id: undefined, email: undefined, name: undefined });
        assert.equal(r.ir.irVersion, "9.0.0");
        assert.equal(r.tagManifest, undefined);
    });

    it("honors an explicit @Tag pin", () => {
        const r = cv(
            `
            import { Schema, Tag } from "@keyma/schema/dsl";
            import type { ID } from "@keyma/schema/dsl";
            @Schema()
            export class Post {
                @Tag(10) id!: ID;
                title!: string;
            }
            `,
            { binaryTags: true },
        );
        assert.deepEqual(errorCodes(r), []);
        assert.deepEqual(tagsOf(r, "Post"), { id: 10, title: 11 });
    });

    it("rejects an invalid @Tag with KEYMA102", () => {
        const r = cv(
            `
            import { Schema, Tag } from "@keyma/schema/dsl";
            @Schema()
            export class P { @Tag(0) a!: string; }
            `,
            { binaryTags: true },
        );
        assert.ok(errorCodes(r).includes("KEYMA102"));
    });

    it("@RenamedFrom carries the committed tag across a rename (seeded manifest)", () => {
        const prev: TagManifest = {
            manifestVersion: "1",
            schemas: { user: { nextTag: 4, fields: { id: 1, email: 2, name: 3 }, tombstones: [] } },
        };
        const renamed = `
            import { Schema, RenamedFrom } from "@keyma/schema/dsl";
            import type { ID } from "@keyma/schema/dsl";
            @Schema()
            export class User {
                id!: ID;
                @RenamedFrom("email") emailAddress!: string;
                name!: string;
            }
        `;
        const r = cv(renamed, { binaryTags: true, tagManifest: prev });
        assert.deepEqual(errorCodes(r), []);
        assert.deepEqual(tagsOf(r, "User"), { id: 1, emailAddress: 2, name: 3 });
    });

    it("flags an un-hinted rename as KEYMA100 (and accepts it with acceptTags)", () => {
        const prev: TagManifest = {
            manifestVersion: "1",
            schemas: { user: { nextTag: 4, fields: { id: 1, email: 2, name: 3 }, tombstones: [] } },
        };
        const renamed = `
            import { Schema } from "@keyma/schema/dsl";
            import type { ID } from "@keyma/schema/dsl";
            @Schema()
            export class User { id!: ID; emailAddress!: string; name!: string; }
        `;
        assert.ok(errorCodes(cv(renamed, { binaryTags: true, tagManifest: prev })).includes("KEYMA100"));

        const accepted = cv(renamed, { binaryTags: true, tagManifest: prev, acceptTags: true });
        assert.deepEqual(errorCodes(accepted), []);
        assert.equal(tagsOf(accepted, "User")["emailAddress"], 4); // fresh tag; old "email" (2) tombstoned
        assert.deepEqual(accepted.tagManifest!.schemas["user"]!.tombstones, [2]);
    });
});

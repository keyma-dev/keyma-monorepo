import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual } from "@keyma/compiler/frontend-ts";
import type { IRClassDeclaration, IRExpression, IRStaticMember } from "@keyma/core/ir";
import { uiFrontendDomain } from "../../src/frontend-ts/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A directory under packages/ui from which `@keyma/ui/dsl` resolves (root node_modules).
const VIRTUAL_BASE = path.join(__dirname, "..", "..", "..", "src", "frontend-ts");

function cv(src: string) {
    return compileVirtual({ "views.ts": src }, { baseDir: VIRTUAL_BASE, domains: [uiFrontendDomain] });
}

/** The `view` static synthesized onto a class, or undefined when the class is not a `@UiView`. */
function viewStatic(cls: IRClassDeclaration): IRStaticMember | undefined {
    return (cls.statics ?? []).find((s) => s.name === "view");
}

/** Reduce a pure-JSON IR expression (object/array/literal) to a plain JS value for assertions. */
function plain(e: IRExpression): unknown {
    if (e.kind === "literal") return e.value;
    if (e.kind === "array") return e.elements.map(plain);
    if (e.kind === "object") {
        const out: Record<string, unknown> = {};
        for (const p of e.properties) out[p.key] = plain(p.value);
        return out;
    }
    throw new Error(`unexpected expression kind "${e.kind}"`);
}

describe("uiFrontendDomain — synthesizes a per-class `view` static", () => {
    it("pushes a `view` json static carrying the @UiView/@Widget catalog data", () => {
        const { ir } = cv(`
import { UiView, Widget } from "@keyma/ui/dsl";
@UiView({ title: "Users", route: "/users" })
export class UserView {
    @Widget("text") declare name: string;
    @Widget("toggle") declare active: boolean;
}
`);
        // The UI domain no longer writes a document-level slice.
        assert.equal(ir.extensions, undefined, "no ir.extensions['ui'] anymore");

        const cls = ir.classes.find((c) => c.sourceName === "UserView");
        assert.ok(cls !== undefined, "UserView lowered as an ordinary class");
        const view = viewStatic(cls);
        assert.ok(view !== undefined, "a `view` static was synthesized");
        assert.deepEqual(view.type, { kind: "json" }, "the static is typed json");
        assert.deepEqual(plain(view.value), {
            name: "UserView",
            title: "Users",
            route: "/users",
            widgets: [
                { field: "name", kind: "text" },
                { field: "active", kind: "toggle" },
            ],
        });
    });

    it("defaults title/route to \"\" and widgets to [] when @UiView has no options/widgets", () => {
        const { ir } = cv(`
import { UiView } from "@keyma/ui/dsl";
@UiView()
export class Bare {}
`);
        const view = viewStatic(ir.classes.find((c) => c.sourceName === "Bare")!);
        assert.ok(view !== undefined);
        assert.deepEqual(plain(view.value), { name: "Bare", title: "", route: "", widgets: [] });
    });

    it("synthesizes no `view` static for a class with no @UiView", () => {
        const { ir } = cv(`export class Plain { declare x: string; }`);
        const cls = ir.classes.find((c) => c.sourceName === "Plain");
        assert.ok(cls !== undefined);
        assert.equal(viewStatic(cls), undefined, "no view static on a non-@UiView class");
        assert.equal(ir.extensions, undefined);
    });

    it("ignores a same-named decorator NOT imported from @keyma/ui/dsl", () => {
        const { ir } = cv(`
function UiView(_options?: unknown): ClassDecorator { return () => undefined; }
@UiView({ title: "x" })
export class Fake { declare y: string; }
`);
        const cls = ir.classes.find((c) => c.sourceName === "Fake");
        assert.ok(cls !== undefined);
        assert.equal(viewStatic(cls), undefined, "an unrelated @UiView contributes no view static");
    });
});

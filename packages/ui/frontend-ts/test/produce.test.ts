import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual } from "@keyma/compiler/frontend-ts";
import { uiFrontendDomain } from "../src/index.js";
import { readUiExtension } from "../../src/extension.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A directory under packages/ui from which `@keyma/ui/dsl` resolves (root node_modules).
const VIRTUAL_BASE = path.join(__dirname, "..", "..", "..", "frontend-ts", "src");

function cv(src: string) {
    return compileVirtual({ "views.ts": src }, { baseDir: VIRTUAL_BASE, domains: [uiFrontendDomain] });
}

describe("uiFrontendDomain.produce", () => {
    it("extracts @UiView classes + @Widget fields into extensions.ui", () => {
        const { ir } = cv(`
import { UiView, Widget } from "@keyma/ui/dsl";
@UiView({ title: "Users", route: "/users" })
export class UserView {
    @Widget("text") declare name: string;
    @Widget("toggle") declare active: boolean;
}
`);
        const ext = readUiExtension(ir);
        assert.ok(ext !== undefined, "extensions.ui present");
        assert.equal(ext.views.length, 1);
        const view = ext.views[0]!;
        assert.equal(view.name, "UserView");
        assert.equal(view.title, "Users");
        assert.equal(view.route, "/users");
        assert.deepEqual(view.widgets, [
            { field: "name", kind: "text" },
            { field: "active", kind: "toggle" },
        ]);
    });

    it("defaults title/route to \"\" when @UiView has no options", () => {
        const { ir } = cv(`
import { UiView } from "@keyma/ui/dsl";
@UiView()
export class Bare {}
`);
        const view = readUiExtension(ir)?.views[0];
        assert.ok(view !== undefined);
        assert.equal(view.title, "");
        assert.equal(view.route, "");
        assert.deepEqual(view.widgets, []);
    });

    it("contributes no extensions when no @UiView is present", () => {
        const { ir } = cv(`export class Plain { declare x: string; }`);
        assert.equal(readUiExtension(ir), undefined);
        assert.equal(ir.extensions, undefined);
    });

    it("ignores a same-named decorator NOT imported from @keyma/ui/dsl", () => {
        const { ir } = cv(`
function UiView(_options?: unknown): ClassDecorator { return () => undefined; }
@UiView({ title: "x" })
export class Fake { declare y: string; }
`);
        assert.equal(readUiExtension(ir), undefined);
    });
});

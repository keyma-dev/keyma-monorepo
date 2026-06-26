import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UiView, Widget } from "../src/index.js";

describe("@keyma/ui/dsl decorators", () => {
    it("UiView is a no-op class decorator factory", () => {
        const decorator = UiView({ title: "Users", route: "/users" });
        assert.equal(typeof decorator, "function");
        assert.equal(decorator(class {}), undefined);
    });

    it("UiView works with no options", () => {
        assert.equal(typeof UiView(), "function");
    });

    it("Widget is a no-op property decorator factory", () => {
        const decorator = Widget("text");
        assert.equal(typeof decorator, "function");
        assert.equal(decorator({}, "field"), undefined);
    });

    it("Widget accepts an options object", () => {
        assert.equal(typeof Widget("select", { label: "Status" }), "function");
    });

    it("composes decorators without runtime errors", () => {
        assert.doesNotThrow(() => {
            @UiView({ title: "Users", route: "/users" })
            class UserView {
                @Widget("text") declare name: string;
                @Widget("toggle") declare active: boolean;
            }
            return UserView;
        });
    });
});

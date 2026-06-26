import type {
    KeymaIR, IRSchema, IRField, IRType, IRExpression,
    IRValidatorDeclaration, IRFormatterDeclaration, IREnumDeclaration, IRService,
} from "@keyma/core/ir";
import { setFieldExtSlice, type IRFieldIndex, type FieldExtData } from "../../src/ir/extensions.js";

// Small builders for constructing IR inline in tests.
const src = (file: string) => ({ file: `/proj/src/${file}`, line: 1, column: 1 });
export const lit = (value: string | number | boolean | null): IRExpression => ({ kind: "literal", value });
export const id = (name: string): IRExpression => ({ kind: "identifier", name });
export const fieldRef = (name: string): IRExpression => ({ kind: "field", name });
export const intr = (op: string, receiver: IRExpression | null, args: IRExpression[] = []): IRExpression =>
    ({ kind: "intrinsic", op, receiver, args });
export const tmpl = (...parts: IRExpression[]): IRExpression => ({ kind: "template", parts });

type FExtra = Partial<IRField> & { indexes?: IRFieldIndex[]; ephemeral?: boolean };
function f(name: string, type: IRType, extra: FExtra = {}): IRField {
    const { indexes, ephemeral, ...rest } = extra;
    const field: IRField = { name, type, visibility: "public", readonly: false, required: true, validators: [], formatters: [], source: src("user.ts"), ...rest };
    const ext: FieldExtData = {};
    if (indexes !== undefined && indexes.length > 0) ext.indexes = indexes;
    if (ephemeral === true) ext.ephemeral = true;
    setFieldExtSlice(field, ext);
    return field;
}

export const minLengthDecl: IRValidatorDeclaration = {
    name: "minLength",
    factoryParams: [{ name: "value" }],
    inputType: { kind: "string" },
    body: {
        params: [{ name: "raw", role: "value" }, { name: "field", role: "field" }],
        statements: [{
            kind: "return",
            value: {
                kind: "conditional",
                condition: { kind: "binary", op: "<", left: intr("string.length", id("raw")), right: id("value") },
                whenTrue: { kind: "object", properties: [
                    { key: "field", value: id("field") },
                    { key: "code", value: lit("minLength") },
                    { key: "message", value: tmpl(id("field"), lit(" must be at least "), id("value"), lit(" characters")) },
                ] },
                whenFalse: lit(null),
            },
        }],
    },
    source: src("validators.ts"),
};

export const trimDecl: IRFormatterDeclaration = {
    name: "trim",
    factoryParams: [],
    inputType: { kind: "string" },
    body: { params: [{ name: "value", role: "value" }], statements: [{ kind: "return", value: intr("string.trim", id("value")) }] },
    source: src("formatters.ts"),
};

const Address: IRSchema = {
    id: "Address", name: "address", sourceName: "Address", visibility: "public",
    fields: [f("street", { kind: "string" }), f("zip", { kind: "string" })],
    source: src("address.ts"),
};

// Tag.owner → user creates a reference CYCLE with User.primaryTag → tag (legal:
// references store only an id, so the by-value embedded-cycle ban does not apply).
const Tag: IRSchema = {
    id: "Tag", name: "tag", sourceName: "Tag", visibility: "public",
    fields: [
        f("id", { kind: "id" }),
        f("label", { kind: "string" }),
        f("owner", { kind: "reference", schema: "user", idType: { kind: "id" } }),
    ],
    extensions: { schema: { indexes: [{ fields: [{ name: "id", direction: 1 }], unique: true }] } }, source: src("tag.ts"),
};

// A named enum (declared in user.ts → emitted into the user module header).
export const statusEnum: IREnumDeclaration = {
    name: "Status",
    members: [{ name: "Active", value: "active" }, { name: "Archived", value: "archived" }],
    source: src("user.ts"),
};

// A service authored as an abstract class → pure-virtual C++ interface.
export const accountService: IRService = {
    id: "AccountService", name: "AccountService", sourceName: "AccountService", visibility: "public",
    description: "Account lifecycle operations.",
    methods: [
        { name: "signup", params: [{ name: "user", type: { kind: "embedded", schema: "user" } }],
            returnType: { kind: "reference", schema: "user", idType: { kind: "id" } }, visibility: "public", source: src("services.ts") },
        { name: "resend", params: [{ name: "email", type: { kind: "string" } }],
            returnType: { kind: "boolean" }, visibility: "public", source: src("services.ts") },
        { name: "listTags", params: [], returnType: { kind: "array", of: { kind: "embedded", schema: "tag" } },
            visibility: "public", source: src("services.ts") },
        { name: "purge", params: [], returnType: { kind: "boolean" }, visibility: "private", source: src("services.ts") },
    ],
    source: src("services.ts"),
};

const Secret: IRSchema = {
    id: "Secret", name: "secret", sourceName: "Secret", visibility: "private",
    fields: [f("token", { kind: "string" })],
    source: src("secret.ts"),
};

const User: IRSchema = {
    id: "User", name: "user", sourceName: "User", visibility: "public",
    fields: [
        f("id", { kind: "id" }, { readonly: true }),
        f("firstName", { kind: "string" }, {
            validators: [{ name: "minLength", params: { value: 2 } }],
            formatters: [{ phase: "change", spec: { name: "trim" } }, { phase: "save", spec: { name: "trim" } }],
            indexes: [{}],
        }),
        f("lastName", { kind: "string" }),
        f("age", { kind: "integer" }),
        f("secretNote", { kind: "string" }, { visibility: "private" }),
        f("nickname", { kind: "string" }, { required: false }),
        f("bio", { kind: "string" }, { nullable: true }),
        f("alias", { kind: "string" }, { required: false, nullable: true }),
        f("role", { kind: "string" }, { default: { kind: "literal", value: "user" } }),
        f("status", { kind: "enum", name: "Status", values: ["active", "archived"] }, { default: { kind: "literal", value: "active" } }),
        f("created", { kind: "dateTime" }, { default: { kind: "expression", expression: { kind: "new", callee: id("Date"), args: [] } } }),
        f("address", { kind: "embedded", schema: "address" }),
        f("primaryTag", { kind: "reference", schema: "tag", idType: { kind: "id" } }),
        f("tags", { kind: "array", of: { kind: "string" } }),
        f("meta", { kind: "json" }),
    ],
    // Getters are behaviors (re-emitted accessors), not schema fields.
    methods: [
        { name: "fullName", kind: "getter", params: [], returnType: { kind: "string" },
            statements: [{ kind: "return", value: tmpl(fieldRef("firstName"), lit(" "), fieldRef("lastName")) }], visibility: "public", source: src("user.ts") },
        // Interpolates the named enum in a template literal — exercises std::formatter<enum>.
        { name: "badge", kind: "getter", params: [], returnType: { kind: "string" },
            statements: [{ kind: "return", value: tmpl(fieldRef("firstName"), lit(" ["), fieldRef("status"), lit("]")) }], visibility: "public", source: src("user.ts") },
        // Reads a reference's id — must lower to `this->primaryTag->id` (shared_ptr).
        { name: "tagKey", kind: "getter", params: [], returnType: { kind: "string" },
            statements: [{ kind: "return", value: { kind: "member", object: fieldRef("primaryTag"), member: "id" } }], visibility: "public", source: src("user.ts") },
        { name: "greet", kind: "method", params: [], returnType: { kind: "string" },
            statements: [{ kind: "return", value: tmpl(lit("Hi "), fieldRef("firstName")) }], visibility: "public", source: src("user.ts") },
    ],
    extensions: { schema: { indexes: [{ fields: [{ name: "firstName", direction: 1 }], unique: false }] } },
    source: src("user.ts"),
};

/** A representative IR: nested modules, embedded + reference, private schema/field, validators, formatters, defaults, getters, methods, indexes. */
export function sampleIR(): KeymaIR {
    return {
        irVersion: "4.0.0", compilerVersion: "0.1.0", sourceRoot: "/proj/src",
        schemas: [Address, Tag, Secret, User],
        validatorDeclarations: [minLengthDecl], formatterDeclarations: [trimDecl], functionDeclarations: [],
        enums: [statusEnum], services: [accountService],
        diagnostics: [],
    };
}

/** Find an emitted file's content by suffix (paths are POSIX). */
export function fileBySuffix(files: { path: string; content: string | Uint8Array }[], suffix: string): string {
    const hit = files.find((f) => f.path.endsWith(suffix));
    if (hit === undefined) throw new Error(`No emitted file ending in "${suffix}". Got: ${files.map((f) => f.path).join(", ")}`);
    return typeof hit.content === "string" ? hit.content : Buffer.from(hit.content).toString("utf-8");
}

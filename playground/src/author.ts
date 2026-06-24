import {
    Schema,
    Validate,
    Format,
    FormField,
    Indexed,
    Deprecated,
    Phase,
} from "@keyma/dsl";
import type { Bytes, Nullable } from "@keyma/dsl";
import {
    minLength,
    maxLength,
    isEmail,
    isUrl,
    isPhoneNumber,
    pattern,
    oneOf,
} from "@keyma/validators";
import {
    trim,
    lowercase,
    capitalize,
    titleCase,
    normalizeEmail,
    normalizeUrl,
    normalizePhone,
    normalizeWhitespace,
} from "@keyma/formatters";
import { Entity } from "./base.js";
import { notReserved } from "./lib/validators.js";

/** A named, reusable string enum — authored once, referenced across schemas. */
export enum Role {
    Owner = "owner",
    Editor = "editor",
    Viewer = "viewer",
}

@Schema({ name: "author", description: "A person who can write posts and comments." })
export class Author extends Entity {

    // Every formatter phase exercised on one field: trim on each keystroke,
    // normalize on blur, lowercase before persistence.
    @Validate(isEmail())
    @Format(Phase.Change, trim())
    @Format(Phase.Blur, normalizeEmail())
    @Format(Phase.Save, lowercase())
    @Indexed({ unique: true })
    @FormField({
        title: "Email",
        hint: "We never share this.",
        placeholder: "you@example.com",
        group: "Account",
        order: 1,
    })
    declare email: string;

    @Validate(minLength(2), maxLength(40))
    @Format(Phase.Change, trim())
    @Format(Phase.Submit, capitalize())
    @FormField({ title: "First name", group: "Profile", order: 2 })
    declare firstName: string;

    @Validate(minLength(2), maxLength(40))
    @Format(Phase.Submit, capitalize())
    @FormField({ title: "Last name", group: "Profile", order: 3 })
    declare lastName: string;

    // Optional + nullable handle: a sparse unique index, a regex pattern and a
    // project-local custom validator.
    @Validate(minLength(3), maxLength(20), pattern("^[a-z0-9_]+$"), notReserved())
    @Format(Phase.Change, lowercase())
    @Indexed({ unique: true, sparse: true })
    declare username?: Nullable<string>;

    @Validate(isUrl())
    @Format(Phase.Blur, normalizeUrl())
    declare website?: string;

    @Validate(isPhoneNumber())
    @Format(Phase.Change, normalizePhone())
    declare phone?: string;

    @Validate(maxLength(280))
    @Format(Phase.Submit, normalizeWhitespace())
    @FormField({ title: "Bio", placeholder: "Tell us about yourself", group: "Profile", order: 4 })
    declare bio?: string;

    // A plain string field constrained to a fixed set, with a literal default.
    @Validate(oneOf("light", "dark", "system"))
    theme: string = "system";

    // Enum field with an enum-literal default.
    role: Role = Role.Viewer;

    // Binary blob (base64 on the wire).
    declare avatar?: Bytes;

    @Deprecated("Use `website` instead.")
    declare homepage?: string;

    // A private field (TS `private`): present in the server bundle, stripped from
    // client bundles and from `serialize(..., { target: "client" })`.
    private securityStamp?: string;

    // A getter behavior + a setter that distributes the written value back into
    // real fields (getter/setter accessor pair). Getters are re-emitted as class
    // accessors in every target; they are not schema fields.
    get fullName(): string {
        return `${this.firstName} ${this.lastName}`;
    }
    set fullName(value: string) {
        this.firstName = value;
    }

    // A standalone setter (no matching getter) — a virtual writable property
    // that normalizes the value into a stored field.
    set primaryEmail(value: string) {
        this.email = value.trim();
    }

    // A plain instance method — emitted onto the generated class in every target.
    greeting(prefix: string): string {
        return `${prefix} ${this.firstName.toUpperCase()}`;
    }
}

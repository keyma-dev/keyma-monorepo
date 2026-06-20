import {
    Schema,
    Validate,
    Indexed,
    Format,
    Phase,
    Computed,
    FormField,
    DateTime,
    Embedded, Json, Ephemeral, Edge, From, To, Reference,
} from "@keyma/dsl";
import type { ID, ValidatorFn } from "@keyma/dsl";
import { minLength } from "@keyma/validators";
import { trim } from "@keyma/formatters";
import { Address } from "./address.js";

// A project-local validator: a plain factory returning a ValidatorFn. The compiler
// re-emits its body directly into the generated schema (no registry wiring).
export function notBadEmail(): ValidatorFn<string> {
    return (value, field) => value.includes("bad")
        ? { field: field, code: "BAD_EMAIL", message: "Email is bad" }
        : null;
}

// A named, reusable string enum — authored once, referenced across schemas.
export enum Role {
    Admin = "admin",
    Member = "member",
    Guest = "guest",
}

@Schema({ name: "user" })
export class User {

    @Indexed({ unique: true })
    declare readonly id: ID;

    @Validate(minLength(2))
    @Format(Phase.Change, trim())
    @FormField({ title: "First name", order: 1 })
    declare firstName: string;

    declare lastName?: string;

    // Computed fields are explicit and use the portable expression subset.
    @Computed() get fullName(): string {
        return `${this.firstName} ${this.lastName}`;
    }

    // A getter/setter pair: the getter is a computed field, the setter is a
    // portable behavior that distributes the written value back into real fields.
    set fullName(value: string) {
        this.firstName = value;
    }

    @Validate(notBadEmail())
    declare email: string;

    // A plain instance method — emitted onto the generated class in every target.
    // Body uses the portable subset: params, `this.<field>`, intrinsics, templates.
    greeting(prefix: string): string {
        return `${prefix} ${this.firstName.toUpperCase()}`;
    }

    // A standalone setter (no matching getter) — a "virtual" writable property
    // that normalizes the value into a stored field.
    set primaryEmail(value: string) {
        this.email = value.trim();
    }

    role: Role = Role.Member;

    declare address?: Embedded<Address>;

    @Ephemeral()
    declare tempData: Json;

    private otherUser?: Reference<User>;

    private _password?: string;

    createdOn: DateTime = (() => new Date())();
    declare updatedOn: DateTime;

}


@Edge({ name: "KNOWS" })
export class Knows {
    declare id: ID;
    declare since: DateTime;

    @From() declare _from: Reference<User>;
    @To() declare _to: Reference<User>;
}

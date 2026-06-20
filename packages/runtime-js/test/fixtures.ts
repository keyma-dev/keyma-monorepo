// Shared test fixtures: schema metadata + branded model classes.

import type { SchemaMetadata, SchemaClass, ValidatorFn, FormatterFn } from "../src/types.js";
import { brandSchema } from "../src/brand.js";

// Direct-ref validators/formatters — the shape the compiler now emits into metadata.
const required: ValidatorFn = (value, field) =>
    value !== undefined && value !== null && value !== "" ? null : { field, code: "required", message: `${field} is required` };
const emailAddress: ValidatorFn = (value, field) =>
    typeof value === "string" && value.includes("@") ? null : { field, code: "emailAddress", message: `${field} must be an email` };
const minLength = (n: number): ValidatorFn => (value, field) =>
    typeof value === "string" && value.length >= n ? null : { field, code: "minLength", message: `${field} too short` };
const normalizeEmail: FormatterFn = (value) => (typeof value === "string" ? value.trim().toLowerCase() : value);

// ─── Organization ────────────────────────────────────────────────────────────

export interface OrganizationRecord {
    id: string;
    name: string;
    tier: string;
}

export const ORGANIZATION_SCHEMA: SchemaMetadata = {
    name: "organization",
    sourceName: "Organization",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true, validators: [required] },
        { name: "name", type: { kind: "string" }, validators: [required] },
        { name: "tier", type: { kind: "string" }, required: false },
    ],
};

class OrganizationCtor {
    declare id: string;
    declare name: string;
    declare tier: string;
    constructor(value?: Partial<OrganizationRecord>) {
        if (value) Object.assign(this, value);
    }
}
export const Organization: SchemaClass<OrganizationRecord> = brandSchema(
    OrganizationCtor as new (value?: Partial<OrganizationRecord>) => OrganizationRecord,
    ORGANIZATION_SCHEMA,
);

// ─── Address (embedded) ──────────────────────────────────────────────────────

export interface AddressRecord {
    line1: string;
    city: string;
    postalCode: string;
}

export const ADDRESS_SCHEMA: SchemaMetadata = {
    name: "address",
    sourceName: "Address",
    fields: [
        { name: "line1", type: { kind: "string" } },
        { name: "city", type: { kind: "string" } },
        { name: "postalCode", type: { kind: "string" }, required: false },
    ],
};

class AddressCtor {
    declare line1: string;
    declare city: string;
    declare postalCode: string;
    constructor(value?: Partial<AddressRecord>) {
        if (value) Object.assign(this, value);
    }
}
export const Address: SchemaClass<AddressRecord> = brandSchema(
    AddressCtor as new (value?: Partial<AddressRecord>) => AddressRecord,
    ADDRESS_SCHEMA,
);

// ─── User ────────────────────────────────────────────────────────────────────

export interface UserRecord {
    id: string;
    email: string;
    name: string;
    organization: OrganizationRecord;
    address: AddressRecord;
    secret: string;
}

export const USER_SCHEMA: SchemaMetadata = {
    name: "user",
    sourceName: "User",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true, validators: [required] },
        { name: "email", type: { kind: "string" }, validators: [required, emailAddress], formatters: [{ phase: "save", fn: normalizeEmail }] },
        { name: "name", type: { kind: "string" }, validators: [required, minLength(2)] },
        { name: "organization", type: { kind: "reference", schema: "organization" }, required: false },
        { name: "address", type: { kind: "embedded", schema: "address" }, required: false },
        { name: "secret", type: { kind: "string" }, visibility: "private", required: false },
    ],
};

class UserCtor {
    declare id: string;
    declare email: string;
    declare name: string;
    declare organization: OrganizationRecord;
    declare address: AddressRecord;
    declare secret: string;
    constructor(value?: Partial<UserRecord>) {
        if (value) Object.assign(this, value);
    }
}
export const User: SchemaClass<UserRecord> = brandSchema(
    UserCtor as new (value?: Partial<UserRecord>) => UserRecord,
    USER_SCHEMA,
);

// ─── User variant with `refs` populated (for hydration tests) ────────────────

export interface UserWithRefsRecord {
    id: string;
    email: string;
    name: string;
    organization: OrganizationRecord;
    address: AddressRecord;
    createdAt: Date;
}

export const USER_WITH_REFS_SCHEMA: SchemaMetadata = {
    name: "userWithRefs",
    sourceName: "UserWithRefs",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "email", type: { kind: "string" } },
        { name: "name", type: { kind: "string" } },
        { name: "organization", type: { kind: "reference", schema: "organization" }, required: false },
        { name: "address", type: { kind: "embedded", schema: "address" }, required: false },
        { name: "createdAt", type: { kind: "dateTime" }, required: false },
    ],
    refs: new Map<string, SchemaClass>([
        ["organization", Organization],
        ["address", Address],
    ]),
};

class UserWithRefsCtor {
    declare id: string;
    declare email: string;
    declare name: string;
    declare organization: OrganizationRecord;
    declare address: AddressRecord;
    declare createdAt: Date;
    constructor(value?: Partial<UserWithRefsRecord>) {
        if (value) Object.assign(this, value);
    }
}
export const UserWithRefs: SchemaClass<UserWithRefsRecord> = brandSchema(
    UserWithRefsCtor as new (value?: Partial<UserWithRefsRecord>) => UserWithRefsRecord,
    USER_WITH_REFS_SCHEMA,
);

// ─── Graph fixtures (node + edge schemas with distinct nominal shapes) ──────

export interface PersonRecord { id: string; name: string; _person: true }
export interface CompanyRecord { id: string; name: string; _company: true }

export const PERSON_SCHEMA: SchemaMetadata = {
    name: "person",
    sourceName: "Person",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "name", type: { kind: "string" } },
    ],
};

export const COMPANY_SCHEMA: SchemaMetadata = {
    name: "company",
    sourceName: "Company",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "name", type: { kind: "string" } },
    ],
};

class PersonCtor {
    declare id: string; declare name: string; declare _person: true;
    constructor(value?: Partial<PersonRecord>) { if (value) Object.assign(this, value); }
}
class CompanyCtor {
    declare id: string; declare name: string; declare _company: true;
    constructor(value?: Partial<CompanyRecord>) { if (value) Object.assign(this, value); }
}
export const Person: SchemaClass<PersonRecord> = brandSchema(
    PersonCtor as new (v?: Partial<PersonRecord>) => PersonRecord, PERSON_SCHEMA,
);
export const Company: SchemaClass<CompanyRecord> = brandSchema(
    CompanyCtor as new (v?: Partial<CompanyRecord>) => CompanyRecord, COMPANY_SCHEMA,
);

// Edge schemas. The runtime SchemaMetadata carries the `edge` field; the
// class value gets the structural `__edge` marker via cast (in real generated
// code the JS backend's .d.ts emission does this).

export interface KnowsRecord { id: string; from: string; to: string; since: string }
export interface WorksAtRecord { id: string; from: string; to: string; role: string }

export const KNOWS_SCHEMA: SchemaMetadata = {
    name: "knows",
    sourceName: "Knows",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "from", type: { kind: "reference", schema: "person" } },
        { name: "to", type: { kind: "reference", schema: "person" } },
        { name: "since", type: { kind: "string" } },
    ],
    edge: { from: "person", fromField: "from", to: "person", toField: "to", label: "knows", directed: false },
};

export const WORKS_AT_SCHEMA: SchemaMetadata = {
    name: "worksat",
    sourceName: "WorksAt",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "from", type: { kind: "reference", schema: "person" } },
        { name: "to", type: { kind: "reference", schema: "company" } },
        { name: "role", type: { kind: "string" } },
    ],
    edge: { from: "person", fromField: "from", to: "company", toField: "to", label: "worksat", directed: true },
};

class KnowsCtor {
    declare id: string; declare from: string; declare to: string; declare since: string;
    constructor(v?: Partial<KnowsRecord>) { if (v) Object.assign(this, v); }
}
class WorksAtCtor {
    declare id: string; declare from: string; declare to: string; declare role: string;
    constructor(v?: Partial<WorksAtRecord>) { if (v) Object.assign(this, v); }
}

export const Knows = brandSchema(
    KnowsCtor as new (v?: Partial<KnowsRecord>) => KnowsRecord, KNOWS_SCHEMA,
) as SchemaClass<KnowsRecord> & { readonly __edge?: { from: PersonRecord; to: PersonRecord } };

export const WorksAt = brandSchema(
    WorksAtCtor as new (v?: Partial<WorksAtRecord>) => WorksAtRecord, WORKS_AT_SCHEMA,
) as SchemaClass<WorksAtRecord> & { readonly __edge?: { from: PersonRecord; to: CompanyRecord } };

// ─── Private schemas (for visibility tests) ──────────────────────────────────

export const SECRET_SCHEMA: SchemaMetadata = {
    name: "secret",
    sourceName: "Secret",
    visibility: "private",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true, validators: [required] },
        { name: "value", type: { kind: "string" }, validators: [required] },
    ],
};

export const LOGIN_INPUT_SCHEMA: SchemaMetadata = {
    name: "loginInput",
    sourceName: "LoginInput",
    ephemeral: true,
    fields: [
        { name: "email", type: { kind: "string" }, validators: [required] },
        { name: "password", type: { kind: "string" }, validators: [required] },
    ],
};

export const PRIVATE_EDGE_SCHEMA: SchemaMetadata = {
    name: "privateEdge",
    sourceName: "PrivateEdge",
    visibility: "private",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "from", type: { kind: "reference", schema: "person" } },
        { name: "to", type: { kind: "reference", schema: "person" } },
    ],
    edge: { from: "person", fromField: "from", to: "person", toField: "to", label: "privateEdge", directed: false },
};

"""Shared test fixtures: schema metadata + branded model classes.

Port of ``@keyma/runtime-js`` ``test/fixtures.ts``. Validators/formatters are plain
direct-ref callables — the shape the compiler emits into metadata. Branded classes
carry their metadata as ``Class.schema`` (via ``brand_schema``); their ``__init__``
mirrors the JS ``Object.assign(this, value)`` model constructor.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from keyma.runtime import brand_schema


# ── Direct-ref validators / formatters ───────────────────────────────────────


def required(value, field):
    if value is not None and value != "":
        return None
    return {"field": field, "code": "required", "message": f"{field} is required"}


def email_address(value, field):
    if isinstance(value, str) and "@" in value:
        return None
    return {"field": field, "code": "emailAddress", "message": f"{field} must be an email"}


def min_length(n):
    def _v(value, field):
        if isinstance(value, str) and len(value) >= n:
            return None
        return {"field": field, "code": "minLength", "message": f"{field} too short"}

    return _v


def normalize_email(value):
    return value.strip().lower() if isinstance(value, str) else value


class _Model:
    """Generic generated-style model: assign every supplied key as an attribute."""

    def __init__(self, value: Optional[Dict[str, Any]] = None) -> None:
        if value:
            for k, v in value.items():
                setattr(self, k, v)


# ─── Organization ────────────────────────────────────────────────────────────

ORGANIZATION_SCHEMA: Dict[str, Any] = {
    "name": "organization",
    "sourceName": "Organization",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "readonly": True, "validators": [required]},
        {"name": "name", "type": {"kind": "string"}, "validators": [required]},
        {"name": "tier", "type": {"kind": "string"}, "required": False},
    ],
}


class Organization(_Model):
    pass


brand_schema(Organization, ORGANIZATION_SCHEMA)


# ─── Address (embedded) ──────────────────────────────────────────────────────

ADDRESS_SCHEMA: Dict[str, Any] = {
    "name": "address",
    "sourceName": "Address",
    "fields": [
        {"name": "line1", "type": {"kind": "string"}},
        {"name": "city", "type": {"kind": "string"}},
        {"name": "postalCode", "type": {"kind": "string"}, "required": False},
    ],
}


class Address(_Model):
    pass


brand_schema(Address, ADDRESS_SCHEMA)


# ─── User ────────────────────────────────────────────────────────────────────

USER_SCHEMA: Dict[str, Any] = {
    "name": "user",
    "sourceName": "User",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "readonly": True, "validators": [required]},
        {
            "name": "email",
            "type": {"kind": "string"},
            "validators": [required, email_address],
            "formatters": [{"phase": "save", "fn": normalize_email}],
        },
        {"name": "name", "type": {"kind": "string"}, "validators": [required, min_length(2)]},
        {"name": "organization", "type": {"kind": "reference", "schema": "organization"}, "required": False},
        {"name": "address", "type": {"kind": "embedded", "schema": "address"}, "required": False},
        {"name": "secret", "type": {"kind": "string"}, "visibility": "private", "required": False},
    ],
}


class User(_Model):
    pass


brand_schema(User, USER_SCHEMA)


# ─── User variant with `refs` populated (for hydration tests) ────────────────

USER_WITH_REFS_SCHEMA: Dict[str, Any] = {
    "name": "userWithRefs",
    "sourceName": "UserWithRefs",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "readonly": True},
        {"name": "email", "type": {"kind": "string"}},
        {"name": "name", "type": {"kind": "string"}},
        {"name": "organization", "type": {"kind": "reference", "schema": "organization"}, "required": False},
        {"name": "address", "type": {"kind": "embedded", "schema": "address"}, "required": False},
        {"name": "createdAt", "type": {"kind": "dateTime"}, "required": False},
    ],
    "refs": {"organization": Organization, "address": Address},
}


class UserWithRefs(_Model):
    pass


brand_schema(UserWithRefs, USER_WITH_REFS_SCHEMA)


# ─── Graph fixtures (node + edge schemas) ────────────────────────────────────

PERSON_SCHEMA: Dict[str, Any] = {
    "name": "person",
    "sourceName": "Person",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "readonly": True},
        {"name": "name", "type": {"kind": "string"}},
    ],
}

COMPANY_SCHEMA: Dict[str, Any] = {
    "name": "company",
    "sourceName": "Company",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "readonly": True},
        {"name": "name", "type": {"kind": "string"}},
    ],
}


class Person(_Model):
    pass


class Company(_Model):
    pass


brand_schema(Person, PERSON_SCHEMA)
brand_schema(Company, COMPANY_SCHEMA)


KNOWS_SCHEMA: Dict[str, Any] = {
    "name": "knows",
    "sourceName": "Knows",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "readonly": True},
        {"name": "from", "type": {"kind": "reference", "schema": "person"}},
        {"name": "to", "type": {"kind": "reference", "schema": "person"}},
        {"name": "since", "type": {"kind": "string"}},
    ],
    "edge": {"from": "person", "fromField": "from", "to": "person", "toField": "to", "label": "knows", "directed": False},
}

WORKS_AT_SCHEMA: Dict[str, Any] = {
    "name": "worksat",
    "sourceName": "WorksAt",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "readonly": True},
        {"name": "from", "type": {"kind": "reference", "schema": "person"}},
        {"name": "to", "type": {"kind": "reference", "schema": "company"}},
        {"name": "role", "type": {"kind": "string"}},
    ],
    "edge": {"from": "person", "fromField": "from", "to": "company", "toField": "to", "label": "worksat", "directed": True},
}


class Knows(_Model):
    pass


class WorksAt(_Model):
    pass


brand_schema(Knows, KNOWS_SCHEMA)
brand_schema(WorksAt, WORKS_AT_SCHEMA)


# ─── Private / ephemeral schemas (for visibility tests) ──────────────────────

SECRET_SCHEMA: Dict[str, Any] = {
    "name": "secret",
    "sourceName": "Secret",
    "visibility": "private",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "readonly": True, "validators": [required]},
        {"name": "value", "type": {"kind": "string"}, "validators": [required]},
    ],
}

LOGIN_INPUT_SCHEMA: Dict[str, Any] = {
    "name": "loginInput",
    "sourceName": "LoginInput",
    "ephemeral": True,
    "fields": [
        {"name": "email", "type": {"kind": "string"}, "validators": [required]},
        {"name": "password", "type": {"kind": "string"}, "validators": [required]},
    ],
}

PRIVATE_EDGE_SCHEMA: Dict[str, Any] = {
    "name": "privateEdge",
    "sourceName": "PrivateEdge",
    "visibility": "private",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "readonly": True},
        {"name": "from", "type": {"kind": "reference", "schema": "person"}},
        {"name": "to", "type": {"kind": "reference", "schema": "person"}},
    ],
    "edge": {
        "from": "person",
        "fromField": "from",
        "to": "person",
        "toField": "to",
        "label": "privateEdge",
        "directed": False,
    },
}

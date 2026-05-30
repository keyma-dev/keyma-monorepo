# @keyma/plugin-acl-js

A server plugin for `@keyma/runtime-js` that enforces per-identity, declarative access control rules across every CRUD and traversal operation. Rules, roles, and role assignments live in the host database (managed privately by the plugin — see "Storage" below) and can be edited at runtime without redeploying.

The plugin hooks into the runtime's `beforeOperation`, `transformFilter`, `transformProjection`, `checkWrite`, and `transformResult` extension points. It does not touch generated code; pure configuration.

## Capabilities

- **Subjects** — `anon` (no `identity.id`), `any-user` (any authenticated identity), `user:<id>` (a specific identity), `role:<name>` (any identity that has the role).
- **Actions** — `read`, `list`, `create`, `update`, `delete`, `traverse`. A single rule lists one or more actions, and may target a specific schema by name or all schemas via `"*"`.
- **Row-level predicates** — each rule's `where` is merged into the operation's `where` clause. Filters support the same operator vocabulary the runtime defines for adapters (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$and`, `$or`, `$nor`) plus two placeholder strings:
  - `"$self"` — substituted with `ctx.identity.id`. Unresolved → rule skipped.
  - `"$ctx.path.to.value"` — substituted by walking `RequestContext`. Unresolved → rule skipped.
- **Field-level allow-lists** — `fields.read` trims the projection going to the adapter and strips any plugin-added fields from the response on the way out; `fields.write` rejects (or silently strips, see `stripWrites`) disallowed keys on `create` / `update`.
- **Composition** — among applicable rules, allow predicates are OR-ed, deny predicates are wrapped in `$nor`, and the result is AND-ed with the caller's filter. Unconditional deny rules short-circuit the whole operation.
- **Roles** — resolved either from `ctx.identity.roles` (if the host pre-resolves them) or by looking up `keymaAclRoleAssignment` rows for `ctx.identity.id`. Cached per request.
- **System bypass** — operations with `ctx.identity.isSystem === true` skip all checks. Use this for migrations and internal jobs.

## Storage

The plugin manages three private schemas: `keymaAclRule`, `keymaAclRole`, and `keymaAclRoleAssignment`. **These are not reachable through the host `KeymaServer`** — the host server does not know about them, and attempts to read or write them through it fail with `SCHEMA_NOT_FOUND`. All rule, role, and role-assignment management goes through the typed `admin` handle returned by `createAclPlugin`. The host is responsible for gating access to that handle (e.g., behind an admin-only HTTP route).

## Installation

```ts
import { KeymaServer } from "@keyma/runtime-js";
import { createAclPlugin } from "@keyma/plugin-acl-js";
import { schemas } from "./generated/server";

const { plugin: aclPlugin, admin: acl } = createAclPlugin({ adapter });

const server = new KeymaServer({
    schemas,                  // do NOT include any keymaAcl* schemas
    adapter,
    plugins: [aclPlugin],
});

await server.ensureSchemas();
```

Registering `keymaAclRule`, `keymaAclRole`, or `keymaAclRoleAssignment` on the host `KeymaServer` is a configuration error and causes the plugin to throw at init.

## Admin API

`acl: KeymaAclAdmin` is a typed facade over the same adapter the plugin uses. It has three method blocks:

### Rule management

```ts
// Create a rule: any authenticated user can list/read their own posts
const rule = await acl.addRule({
    subject: { kind: "any-user" },
    schema: "post",
    actions: ["list", "read"],
    where: { author: "$self" },
});

// Extend the rule to also allow update
await acl.updateRule(rule.id, { actions: ["list", "read", "update"] });

// Add a deny rule for flagged posts
await acl.addRule({
    subject: { kind: "any-user" },
    schema: "post",
    actions: ["list", "read"],
    where: { flagged: true },
    effect: "deny",
});

// Field allow-list: anon can read only the public columns
await acl.addRule({
    subject: { kind: "anon" },
    schema: "post",
    actions: ["read", "list"],
    fields: { read: ["id", "title", "publishedAt"] },
});

// Remove a rule
await acl.removeRule(rule.id);

// Look up rules for a given schema or subject
const postRules = await acl.listRules({ schema: "post" });
const adminRules = await acl.listRules({ subject: { kind: "role", name: "admin" } });
```

Ids are assigned by the adapter — never client-generated. Callers receive them via `addRule` / `listRules` return values and pass them back for subsequent operations.

### Role management (catalog)

Define the roles your system understands. Required before assigning them to users or referencing them in rules with `subject: { kind: "role", name: ... }`.

```ts
await acl.addRole("admin");
await acl.addRole("editor");

const roles = await acl.listRoles();        // → [{ id, name: "admin" }, ...]
const admin = await acl.getRole("admin");   // → { id, name: "admin" } or null

// Remove a role (throws KeymaAclRoleInUse if still assigned or referenced
// by any rule — the error's extras carries the dependent ids)
await acl.removeRole("editor");
```

`addRole` is idempotent: calling it again with the same name returns the existing record.

### Role assignment management

```ts
// Assign a role to a user (idempotent; throws KeymaAclUnknownRole if
// "admin" was never declared via addRole)
await acl.assignRole("alice", "admin");

// Revoke an assignment
await acl.unassignRole("alice", "admin");

// Read a user's roles
const aliceRoles = await acl.getUserRoles("alice");    // → ["admin", ...]

// Enumerate assignments
const adminUsers = await acl.listAssignments({ role: "admin" });
```

### Gating the admin handle

`acl` is unguarded. The host wraps it however its auth model demands. A typical Express handler:

```ts
app.post("/admin/acl/rules", requireRole("admin"), async (req, res) => {
    const rule = await acl.addRule(req.body);
    res.json(rule);
});
```

## Rule shape

The in-memory rule type:

```ts
type AclRule = {
    id: string;
    subject:
        | { kind: "anon" }
        | { kind: "any-user" }
        | { kind: "user"; id: string }
        | { kind: "role"; name: string };
    schema: string;              // schema name or "*"
    actions: AclAction[];        // "read" | "list" | "create" | "update" | "delete" | "traverse"
    where?: Record<string, unknown>;
    fields?: { read?: string[]; write?: string[] };
    effect?: "allow" | "deny";   // default "allow"
    priority?: number;           // reserved; ignored in v1
};
```

Storage is a flat shape (the discriminated subject decomposes into `subjectKind` / `subjectId` / `subjectRole`; `where` is stored as JSON). The `KeymaAclAdmin` API hides this — callers always work with the structured `AclRule` / `AclRuleInput` shape above.

### Example: composed filter

Authors can list and read their own posts but never see flagged ones:

```ts
await acl.addRule({
    subject: { kind: "any-user" },
    schema: "post",
    actions: ["list", "read"],
    where: { author: "$self" },
});

await acl.addRule({
    subject: { kind: "any-user" },
    schema: "post",
    actions: ["list", "read"],
    where: { flagged: true },
    effect: "deny",
});
```

Resulting merged filter for a list with `where: { tenant: "acme" }` issued by user `alice`:

```ts
{ $and: [{ tenant: "acme" }, { author: "alice" }, { $nor: [{ flagged: true }] }] }
```

The plugin tracks which fields were referenced by predicates but **not** requested by the caller (e.g. `flagged`), augments the projection so the adapter still returns them for filtering, then strips them from the final response — `transformResult` removes only the fields the plugin added, never fields the caller explicitly asked for.

## Options

```ts
createAclPlugin({
    adapter: KeymaDatabaseAdapter,   // required; same instance as your KeymaServer's adapter
    stripWrites?: boolean,           // silently drop disallowed write fields instead of throwing FIELD_FORBIDDEN
    leakExistence?: boolean,         // when true, denied reads return null; default false (don't leak existence)
    logger?: (level, message, details?) => void,
});
```

## Error surface

All error classes extend `KeymaPluginError` and serialize on the wire with `source: "plugin"` and `origin: "@keyma/plugin-acl-js"`:

| Class | `code` | Cause |
|---|---|---|
| `AclDenied` | `FORBIDDEN` | No allow rule applies, or an unconditional deny rule matches. |
| `AclFieldForbidden` | `FIELD_FORBIDDEN` | A create/update payload includes fields outside the rule's `fields.write` allow-list and `stripWrites` is false. Includes the offending field names in `extras.fields`. |
| `KeymaAclUnknownRole` | `UNKNOWN_ROLE` | `admin.assignRole` or `admin.addRule` (with role subject) referenced a role that hasn't been declared via `admin.addRole(name)`. |
| `KeymaAclRoleInUse` | `ROLE_IN_USE` | `admin.removeRole` was called while assignments or rules still reference the role. The error's `extras` lists the dependent ids. |

## Caveats (v1)

- Predicates apply to top-level fields of the operating schema only. Joined or populated paths are not evaluated by the plugin.
- The `priority` field is reserved for future ordering control; currently ignored.
- Per-request rule cache is keyed by identity and roles, so reusing a `RequestContext` across logical requests will reuse cached rules. Construct a fresh context per request.
- Traversals don't run `transformFilter`, so the plugin enforces `traverse` permission via `beforeOperation` (require at least one allow rule for the terminal schema). Edge-level row predicates for traversals are not yet supported.
- The role catalog (`keymaAclRole`) is only consulted by the admin API — `assignRole` and `addRule` (with role subject) validate against it. Enforcement at request time still works off whatever role strings appear in `keymaAclRoleAssignment` or `ctx.identity.roles`, so the catalog is a write-side hygiene check, not a runtime gate.

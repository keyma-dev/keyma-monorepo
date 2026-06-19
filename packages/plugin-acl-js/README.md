# @keyma/plugin-acl-js

A server plugin for `@keyma/runtime-js` that enforces per-identity, declarative access control across every CRUD and traversal operation. Rules, roles, and role assignments live in the host database — managed by the plugin (see "Storage") — and can be edited at runtime without redeploying.

The plugin hooks into the runtime's `beforeOperation`, `transformOperation`, `transformFilter`, `transformProjection`, `checkWrite`, and `transformResult` extension points. It does not touch generated code; it is pure configuration.

## Capabilities

- **Subjects** — `anon` (no `identity.id`), `any-user` (any authenticated identity), `user:<id>` (a specific identity), `role:<name>` (any identity that has the role).
- **Actions** — `read`, `create`, `update`, `delete`. A single `read` grant governs every read-side operation — `list`, `read`, *and* `traverse` all match `read` rules. A rule lists one or more actions and may target a specific schema by name or all schemas via `"*"`.
- **Row-level predicates** — each rule's `where` is merged into the operation's `where`. Filters use the same operator vocabulary the runtime defines for adapters (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$and`, `$or`, `$nor`) plus two placeholder strings:
  - `"$self"` — substituted with `ctx.identity.id`. Unresolved → rule skipped.
  - `"$ctx.path.to.value"` — substituted by walking `RequestContext`. Unresolved → rule skipped.
- **Field-level allow-lists** — `fields.read` trims the projection going to the adapter and strips plugin-added fields from the response; `fields.write` rejects (or silently strips, see `stripWrites`) disallowed keys on `create`/`update`.
- **Composition** — among applicable rules, allow predicates are OR-ed, deny predicates are wrapped in `$nor`, and the result is AND-ed with the caller's filter. Unconditional deny rules short-circuit the whole operation.
- **Roles** — resolved either from `ctx.identity.roles` (if the host pre-resolves them) or by looking up `keymaAclRoleAssignment` rows for `ctx.identity.id`. Cached per request.
- **Traversals are gated** — non-system identities cannot issue `traverse` operations unless `allowUserTraverse: true`; otherwise `beforeOperation` rejects them with `FORBIDDEN`. When enabled, `read` predicates are injected onto the start and terminal nodes (see "Caveats").
- **System bypass** — operations with `ctx.identity.isSystem === true` skip all checks. Use this for migrations and internal jobs.

## Storage

The plugin owns three schemas — `keymaAclRule`, `keymaAclRole`, and `keymaAclRoleAssignment` — and **registers them itself** during `init` (via the runtime's `addSchema`, which also creates the backing tables/collections). You administer them through the `KeymaAclAdmin` facade, not through your application's normal query flow. Declaring any of these schemas on the host `KeymaServer` yourself is a configuration error and makes the plugin **throw at init**.

## Installation

```ts
import { KeymaServer } from "@keyma/runtime-js";
import { createAclPlugin, KeymaAclAdmin } from "@keyma/plugin-acl-js";
import { schemas } from "./generated/server";

const aclPlugin = createAclPlugin({});   // returns the plugin

const server = new KeymaServer({
    schemas,                // do NOT include any keymaAcl* schemas — the plugin adds them
    adapter,
    plugins: [aclPlugin],
});

await server.ensureSchemas();

// The admin API is a separate facade over the same adapter the plugin uses:
const acl = new KeymaAclAdmin(adapter);
```

`createAclPlugin(options)` returns the plugin only. The admin API is `KeymaAclAdmin`, which you construct directly with the same `adapter` you handed to `KeymaServer`. The host is responsible for gating access to that admin handle (e.g. behind an admin-only HTTP route).

## Admin API

`KeymaAclAdmin` has three method blocks.

### Rule management

```ts
// Any authenticated user can read (and list/traverse) their own posts
const rule = await acl.addRule({
    subject: { kind: "any-user" },
    schema: "post",
    actions: ["read"],
    where: { author: "$self" },
});

// Extend the rule to also allow update
await acl.updateRule(rule.id, { actions: ["read", "update"] });

// Add a deny rule for flagged posts
await acl.addRule({
    subject: { kind: "any-user" },
    schema: "post",
    actions: ["read"],
    where: { flagged: true },
    effect: "deny",
});

// Field allow-list: anon can read only the public columns
await acl.addRule({
    subject: { kind: "anon" },
    schema: "post",
    actions: ["read"],
    fields: { read: ["id", "title", "publishedAt"] },
});

await acl.removeRule(rule.id);
const single = await acl.getRule(rule.id);
const postRules = await acl.listRules({ schema: "post" });
const adminRules = await acl.listRules({ subject: { kind: "role", name: "admin" } });
```

Ids are assigned by the adapter — never client-generated. Callers receive them via `addRule` / `listRules` and pass them back for subsequent operations.

### Role management (catalog)

Define the roles your system understands. Required before assigning them to users or referencing them in rules with `subject: { kind: "role", name: ... }`.

```ts
await acl.addRole("admin");
await acl.addRole("editor");

const roles = await acl.listRoles();        // → [{ id, name: "admin" }, ...]
const admin = await acl.getRole("admin");   // → { id, name: "admin" } or null

// Throws KeymaAclRoleInUse if still assigned or referenced by any rule
await acl.removeRole("editor");
```

`addRole` is idempotent: calling it again with the same name returns the existing record.

### Role assignment management

```ts
await acl.assignRole("alice", "admin");     // idempotent; throws KeymaAclUnknownRole if undeclared
await acl.unassignRole("alice", "admin");
const aliceRoles = await acl.getUserRoles("alice");      // → ["admin", ...]
const adminUsers = await acl.listAssignments({ role: "admin" });
```

## Rule shape

```ts
type AclRule = {
    id: string;
    subject:
        | { kind: "anon" }
        | { kind: "any-user" }
        | { kind: "user"; id: string }
        | { kind: "role"; name: string };
    schema: string;              // schema name or "*"
    actions: AclAction[];        // "read" | "create" | "update" | "delete"
    where?: Record<string, unknown>;
    fields?: { read?: string[]; write?: string[] };
    effect?: "allow" | "deny";   // default "allow"
    priority?: number;           // reserved; ignored in v1
};
```

Storage flattens the discriminated subject into `subjectKind` / `subjectId` / `subjectRole` and stores `where` as JSON. `KeymaAclAdmin` hides this — callers always work with the structured `AclRule` / `AclRuleInput` shape (`AclRuleInput` is `Omit<AclRule, "id">`).

### Example: composed filter

Authors can list and read their own posts but never see flagged ones:

```ts
await acl.addRule({ subject: { kind: "any-user" }, schema: "post", actions: ["read"], where: { author: "$self" } });
await acl.addRule({ subject: { kind: "any-user" }, schema: "post", actions: ["read"], where: { flagged: true }, effect: "deny" });
```

For a list with `where: { tenant: "acme" }` issued by user `alice`, the merged filter is:

```ts
{ $and: [{ tenant: "acme" }, { author: "alice" }, { $nor: [{ flagged: true }] }] }
```

The plugin tracks fields referenced by predicates but **not** requested by the caller (e.g. `flagged`), augments the projection so the adapter still returns them for filtering, then strips them from the response — `transformResult` removes only the fields the plugin added, never fields the caller asked for.

## Options

```ts
createAclPlugin({
    allowUserTraverse?: boolean,     // permit non-system users to issue traverse ops; default false
    stripWrites?: boolean,           // silently drop disallowed write fields instead of throwing FIELD_FORBIDDEN
    leakExistence?: boolean,         // when true, denied reads surface FORBIDDEN; default false (don't leak existence)
    logger?: (level, message, details?) => void,
});
```

## Error surface

All error classes extend `KeymaPluginError` and serialize on the wire with `source: "plugin"` and `origin: "@keyma/plugin-acl-js"`:

| Class | `code` | Cause |
|---|---|---|
| `AclDenied` | `FORBIDDEN` | No allow rule applies, an unconditional deny rule matches, or a user-initiated traversal is blocked. |
| `AclFieldForbidden` | `FIELD_FORBIDDEN` | A create/update payload includes fields outside the rule's `fields.write` allow-list and `stripWrites` is false. Includes the offending field names in `extras.fields`. |
| `KeymaAclUnknownRole` | `UNKNOWN_ROLE` | `assignRole` or `addRule` (with role subject) referenced a role that hasn't been declared via `addRole(name)`. |
| `KeymaAclRoleInUse` | `ROLE_IN_USE` | `removeRole` was called while assignments or rules still reference the role. The error's `extras` lists the dependent ids. |

## Caveats (v1)

- **Traverse enforcement is bounded to the endpoints.** The runtime never runs `transformFilter` for traverse operations, so the plugin injects `read` predicates via `transformOperation` — but only onto the two node schemas it can name from the spec: the **start node** (`spec.start`) and the **terminal node** (the operation's `schema`). Intermediate edges and hopped-through nodes are not predicate-filtered. Field-level `fields.read` trimming still applies to terminal nodes via the projection hook.
- The `priority` field is reserved for future ordering control; currently ignored.
- The per-request rule cache is keyed by identity and roles, so reusing a `RequestContext` across logical requests reuses cached rules. Construct a fresh context per request.
- The role catalog (`keymaAclRole`) is a write-side hygiene check consulted by the admin API (`assignRole` and role-subject `addRule` validate against it). Request-time enforcement works off whatever role strings appear in `keymaAclRoleAssignment` or `ctx.identity.roles`.

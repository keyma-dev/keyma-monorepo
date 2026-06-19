# @keyma/runtime-js

JavaScript target runtime for Keyma. Paired with the code emitted by `@keyma/compiler-backend-js`, it provides everything the generated client and server need at runtime: validation and formatting registries, request serialization, the typed `Keyma` query builder, the `KeymaServer`, the `KeymaDatabaseAdapter` interface, the server-plugin protocol, an in-process transport, and a structured error model.

Beyond `@keyma/dsl` (which is type-only at runtime), this package has zero production dependencies.

## Where it fits

```
@keyma/dsl  →  @keyma/ir  →  @keyma/compiler-frontend-ts  →  @keyma/compiler
                                                                  ↓
                                              @keyma/compiler-backend-js  →  generated JS  →  @keyma/runtime-js + adapter
```

Generated code embeds static `SchemaMetadata` and consumes the runtime through the `@keyma/runtime-js` import. Adapters (e.g. `@keyma/adapter-mongodb-js`, `@keyma/adapter-sqlite-js`, `@keyma/adapter-gremlin-js`) implement `KeymaDatabaseAdapter` and plug into `KeymaServer`.

## Minimal server

```ts
import { KeymaServer, createDirectTransport } from "@keyma/runtime-js";
import { MongoAdapter } from "@keyma/adapter-mongodb-js";
import { schemas } from "./generated/server";

const server = new KeymaServer({
    schemas,
    adapter: new MongoAdapter({ url: "mongodb://localhost:27017", db: "myapp" }),
});

await server.ensureSchemas();
const transport = createDirectTransport(server);
```

`KeymaServer`'s public surface is small: `ensureSchemas()` (persist every non-ephemeral schema through the adapter), `handle(request, context?)` (process a request batch), and `close()` (delegates to `adapter.close?.()`). `createDirectTransport` accepts an optional `contextFactory` that runs per request — wire it to `AsyncLocalStorage` (or whatever your framework uses) to surface a `RequestContext` with `identity` to plugins.

## The `Keyma` query builder

The client builds typed, declarative queries that serialize to a portable request document and dispatch through a `Transport`. `Keyma` exposes `query` and `mutation` (document builders), the leaf builders `list` / `read` / `create` / `update` / `delete` / `traverse` / `count`, and `input` (a request-time placeholder). The same document can mix CRUD leaves and graph traversals in one batch and returns a typed, projected response.

## Writing a database adapter

A `KeymaDatabaseAdapter` implements seven required methods — `ensureSchema`, `create`, `read`, `list`, `update`, `delete`, `count` — and may add the optional `traverse`, `connect`, `close`, and a `capabilities` descriptor:

```ts
import type {
    KeymaDatabaseAdapter,
    SchemaMetadata,
    ListQuery,
    AdapterProjection,
} from "@keyma/runtime-js";

export class MyAdapter implements KeymaDatabaseAdapter {
    readonly capabilities = {
        traverse: { maxDepth: 8, heterogeneous: true, emitPaths: true },
    } as const;

    async ensureSchema(schema: SchemaMetadata): Promise<void> { /* … */ }
    async create(schema: SchemaMetadata, data: Record<string, unknown>, projection?: AdapterProjection) { /* … */ }
    async read(schema: SchemaMetadata, where: Record<string, unknown>, projection?: AdapterProjection) { /* … */ }
    async list(schema: SchemaMetadata, query: ListQuery) { /* … */ }
    async update(schema: SchemaMetadata, where: Record<string, unknown>, data: Record<string, unknown>, projection?: AdapterProjection) { /* … */ }
    async delete(schema: SchemaMetadata, where: Record<string, unknown>): Promise<void> { /* … */ }
    async count(schema: SchemaMetadata, where?: Record<string, unknown>): Promise<number> { /* … */ }

    // Optional:
    async connect(): Promise<void> { /* … */ }
    async close(): Promise<void> { /* … */ }
}
```

### Filter shape

Every `where` object the runtime hands an adapter — whether on `read`, `list`, `update`, `delete`, `count`, or nested inside a `TraversalSpec` — follows one canonical shape (see `src/adapter.ts` for the authoritative comment):

- Top-level keys are field names of the operation's schema; `id` is a reserved alias the adapter may rewrite to its native primary-key column.
- Field values are either literals (compared with equality) or operator objects using `$eq` / `$ne` / `$gt` / `$gte` / `$lt` / `$lte` / `$in` / `$nin`.
- Top-level keys `$and` / `$or` / `$nor` are logical combinators carrying an array of sub-filter objects of the same shape, recursively combined against the same schema.

Plugins like `@keyma/plugin-acl-js` use the logical combinators to merge policy clauses into the client's filter; adapters must support them. The client-side query builder does not surface combinators directly — they appear only after plugin transformation.

### Traversals

Adapters opt into graph traversals by setting `capabilities.traverse` and implementing `traverse(ctx, spec, projection)`. `ctx` resolves all schema names referenced by the spec (start, terminal, edges, intermediate nodes) so the implementation never has to look them up by string. Return:

- `Record<string, unknown>[]` for `emit: "nodes"` (terminal-node records) or `emit: "edges"` (last-hop edge records).
- `{ nodes, edges }[]` for `emit: "paths"`.

## Writing a server plugin

Plugins implement `KeymaServerPlugin` — a `name` plus any of the optional hooks `init`, `transformOperation`, `beforeOperation`, `transformFilter`, `transformProjection`, `checkWrite`, `transformResult`, and `afterOperation`. They fire in array order at well-defined points in the operation lifecycle; `transformOperation` runs first and can rewrite the whole operation (this is how the ACL plugin injects read predicates into traversals, which never run `transformFilter`). See the "Server plugins" section in the root `README.md` for the protocol overview and hook ordering, and `@keyma/plugin-acl-js` for a worked example.

## Errors

Throwing any subclass of `KeymaError` from a plugin or adapter produces a structured `KeymaLeafFailure` on the wire:

```ts
const error = { ok: false, code: "FORBIDDEN", error: "...", source: "plugin", origin: "@keyma/my-plugin", /* extras */ }
```

- `KeymaRuntimeError` — `source: "runtime"`; raised by the server (validation, missing schema, NOT_FOUND, …).
- `KeymaPluginError` — `source: "plugin"`; `origin` is the plugin package name. Use `extras` for structured detail (e.g. `{ fields: [...] }`).
- `KeymaAdapterError` — `source: "adapter"`; same shape as plugin errors, with the adapter package as `origin`.

Predicate helpers `isRuntimeFailure` / `isPluginFailure` / `isAdapterFailure` narrow a `KeymaLeafFailure` by source.

## `@keyma/runtime-js/testing`

The `./testing` subpath exports an `InMemoryAdapter` (a fully in-memory `KeymaDatabaseAdapter`, including traversals) plus the `matches` / `matchesOp` filter evaluators — handy for unit-testing schemas and plugins without a real database.

## Status

Pre-alpha. The public surface of this package is the contract between generated code and consumer applications, and is expected to stabilize before other parts of the pipeline.

# @keyma/runtime-js

JavaScript target runtime for Keyma. Paired with the code emitted by `@keyma/compiler-backend-js`, it provides everything the generated client and server need at runtime: validation and formatting registries, request serialization, the typed `Keyma` query builder, the `KeymaServer`, the `KeymaDatabaseAdapter` interface, the server-plugin protocol, an in-process transport, and a structured error model.

Beyond `@keyma/dsl` (which is type-only at runtime), this package has zero production dependencies.

## Where it fits

```
@keyma/dsl  →  @keyma/ir  →  @keyma/compiler-frontend-ts  →  @keyma/compiler
                                                                  ↓
                                              @keyma/compiler-backend-js  →  generated JS  →  @keyma/runtime-js + adapter
```

Generated code embeds static `SchemaMetadata` and consumes the runtime through the `@keyma/runtime-js` import. Adapters (e.g. `@keyma/adapter-mongodb-js`, `@keyma/adapter-sqlite-js`) implement `KeymaDatabaseAdapter` and plug into `KeymaServer`.

## Exports

| Concern | Exports |
|---|---|
| Schema metadata | `SchemaMetadata`, `FieldMetadata`, `EdgeMetadata`, `FieldType`, `FieldIndex`, `SchemaIndex`, `ValidatorSpec`, `FormatterSpec`, `SchemaClass`, `RecordOf`, `brandSchema` |
| Wire protocol | `KeymaRequest`, `KeymaBatchResponse`, `KeymaLeafResult`, `KeymaLeafSuccess`, `KeymaLeafFailure`, `KeymaOperation`, `ProjectionSpec`, `ListOptions`, `Transport`, `TraversalSpec`, `TraversalStep`, `TraversalDirection`, `TraversalEmit` |
| Query builder | `Keyma.query`, `Keyma.mutation`, `Keyma.list`, `Keyma.read`, `Keyma.create`, `Keyma.update`, `Keyma.delete`, `Keyma.traverse`, `Keyma.input`; plus leaf and document types (`AnyLeaf`, `QueryDocument`, `MutationDocument`, `RequestResults`, `DocumentInputs`, …) |
| Server | `KeymaServer`, `createDirectTransport` |
| Adapter contract | `KeymaDatabaseAdapter`, `ListQuery`, `AdapterProjection`, `AdapterFieldSpec`, `PopulateSpec`, `PopulateNode`, `AdapterCapabilities`, `AdapterTraversalContext`, `AdapterTraversalResult` |
| Plugin contract | `KeymaServerPlugin`, `PluginServerHandle`, `RequestContext`, `AclAction` |
| Validation | `validate`, `createDefaultValidatorRegistry`, `ValidatorFn`, `ValidatorRegistry`, `ValidatorContext` |
| Formatting | `format`, `createDefaultFormatterRegistry`, `FormatterFn`, `FormatterRegistry`, `FormatterContext` |
| Serialization | `serialize`, `deserialize`, `SerializeTarget`, `applyMaterializers`, `MaterializerFn` |
| Errors | `KeymaError`, `KeymaRuntimeError`, `KeymaPluginError`, `KeymaAdapterError`, `ErrorSource`, `isPluginFailure`, `isAdapterFailure`, `isRuntimeFailure` |

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

`createDirectTransport` accepts an optional `contextFactory` that runs per request — wire it to `AsyncLocalStorage` (or whatever your framework uses) to surface a `RequestContext` with `identity` to plugins.

## Custom validators and formatters

The default registries cover the built-in markers from `@keyma/dsl` (`required`, `minLength`, `isEmailAddress`, `trim`, `normalizeEmail`, …). Extend them with project-specific rules and pass the registry to `KeymaServer`:

```ts
import {
    KeymaServer,
    createDefaultValidatorRegistry,
    createDefaultFormatterRegistry,
    type ValidatorFn,
    type FormatterFn,
} from "@keyma/runtime-js";

const validators = createDefaultValidatorRegistry();
const isShortSlug: ValidatorFn = (value, _spec, field) =>
    typeof value === "string" && /^[a-z0-9-]{1,32}$/.test(value)
        ? null
        : { field, kind: "isShortSlug", message: `${field} must be a short slug` };
validators.set("isShortSlug", isShortSlug);

const formatters = createDefaultFormatterRegistry();
const stripDiacritics: FormatterFn = (value) =>
    typeof value === "string" ? value.normalize("NFD").replace(/\p{Diacritic}/gu, "") : value;
formatters.set("stripDiacritics", stripDiacritics);

const server = new KeymaServer({ schemas, adapter, validators, formatters });
```

Validators and formatters reference each other through the `kind` field on the spec; the names you register here must match the marker names emitted by the compiler.

## Writing a database adapter

A `KeymaDatabaseAdapter` is a plain object implementing five required methods (`ensureSchema`, `create`, `read`, `list`, `update`, `delete`) and one optional one (`traverse`):

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
}
```

### Filter shape

Every `where` object the runtime hands an adapter — whether on `read`, `list`, `update`, `delete`, or nested inside a `TraversalSpec` — follows one canonical shape (see `src/adapter.ts` for the authoritative comment):

- Top-level keys are field names of the operation's schema; `id` is a reserved alias the adapter may rewrite to its native primary-key column.
- Field values are either literals (compared with equality) or operator objects using `$eq` / `$ne` / `$gt` / `$gte` / `$lt` / `$lte` / `$in` / `$nin`.
- Top-level keys `$and` / `$or` / `$nor` are logical combinators carrying an array of sub-filter objects of the same shape, recursively combined against the same schema.

Plugins like `@keyma/plugin-acl-js` use the logical combinators to merge policy clauses into the client's filter; adapters must support them. The client-side query builder does not surface combinators directly — they appear only after plugin transformation.

### Traversals

Adapters opt into graph traversals by setting `capabilities.traverse` and implementing `traverse(ctx, spec, projection)`. `ctx` resolves all schema names referenced by the spec (start, terminal, edges, intermediate nodes) so the implementation never has to look them up by string. Return:

- `Record<string, unknown>[]` for `emit: "nodes"` (terminal-node records) or `emit: "edges"` (last-hop edge records).
- `{ nodes, edges }[]` for `emit: "paths"`.

## Writing a server plugin

Plugins implement `KeymaServerPlugin`. See the "Server plugins" section in the root `README.md` for the protocol overview and hook ordering, and look at `@keyma/plugin-acl-js` for a worked example covering filter rewrites, projection augmentation, write checks, and result trimming.

## Errors

Throwing any subclass of `KeymaError` from a plugin or adapter produces a structured `KeymaLeafFailure` on the wire:

```ts
{ ok: false, code: "FORBIDDEN", error: "...", source: "plugin", origin: "@keyma/my-plugin", /* extras */ }
```

- `KeymaRuntimeError` — `source: "runtime"`; raised by the server (validation, missing schema, NOT_FOUND, …).
- `KeymaPluginError` — `source: "plugin"`; `origin` is the plugin package name. Use `extras` for structured detail (e.g. `{ fields: [...] }`).
- `KeymaAdapterError` — `source: "adapter"`; same shape as plugin errors, with the adapter package as `origin`.

Predicate helpers `isRuntimeFailure` / `isPluginFailure` / `isAdapterFailure` narrow a `KeymaLeafFailure` by source.

## Status

Pre-alpha. The public surface of this package is the contract between generated code and consumer applications, and is expected to stabilize before other parts of the pipeline.

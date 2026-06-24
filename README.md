# Keyma (Pre-alpha)

A declarative schema compiler for full-stack applications.

You define data models, validation rules, formatting behavior, indexes, computed fields, relationships, and **edges** in TypeScript. Keyma compiles those schemas into small, dependency-free target libraries for runtimes such as JavaScript, Python, and C++.

Keyma is **database-agnostic** and **transport-agnostic** by design:

* **Database-agnostic** — the same schemas run against graph, document, and relational databases. The runtime talks to your data through a `KeymaDatabaseAdapter`. Bring an adapter (MongoDB, SQLite, and Gremlin adapters ship in the monorepo; others are pluggable) and the generated code doesn't change.
* **Transport-agnostic** — the client serializes queries to a portable, language-neutral request document and hands it to a `Transport` function you supply. HTTP, WebSocket, gRPC, in-process, message bus — Keyma doesn't care. An in-process `createDirectTransport` is provided for SSR and tests.
* **Graph queries, on any backend** — schemas can declare `@Edge` classes whose `@From()`/`@To()` fields name the connected node schemas. `Keyma.traverse(...)` builds typed, multi-hop graph queries (heterogeneous chains, homogeneous repeats with depth bounds, edge predicates) that compile to native traversals on graph databases and to emulated joins/lookups on document and relational stores. The query surface is identical regardless of backend.

The generated schema libraries have **no** external dependencies; you can use them as-is in any project, or pair them with a provided runtime such as `@keyma/runtime-js`.

## Introduction

**Keyma** lets you express data models, relationships, edges, and form input requirements once, in a unified declarative way, and use them everywhere.

* **Declarative** — define data models, relationships, and graph edges using clear, concise decorators.
* **Compiled** — TypeScript is the authoring language. Keyma parses your source via the TypeScript compiler API, builds a language-neutral intermediate representation (IR), and emits target-specific code.
* **Full stack** — write once and consume your schemas on both client and server. Keyma produces two distinct generated libraries: one for the backend (with private fields and server-only schemas) and one for the frontend (with only public surface area).
* **Multi-language** — the compiler has a frontend/backend architecture. The built-in frontend reads TypeScript. Backends can target any language; JavaScript, Python, and C++ backends ship today, and others can be added.
* **Database-agnostic** — one schema, many storage models. Adapters bridge the runtime to graph, document, or relational databases. Computed fields and edge traversals are lowered appropriately for each.
* **Transport-agnostic** — the generated client emits portable query documents. You provide the transport.
* **Lightweight output** — generated code is plain — no decorators, no reflect-metadata, no tslib. Only a small runtime library is required at consumption time.
* **Scaffolding** — a simple CLI generates projects, schema files, and build outputs.

Whether you are building a simple CRUD app, a richly relational system, or a graph-native application, **Keyma** bridges the gap between data modeling and application logic — across languages, across databases, across transports.

---

## Architecture Overview

- TypeScript schema source files
- TypeScript compiler frontend (uses the TypeScript compiler API)
- Keyma language-neutral IR (`.keyma/schema.ir.json`)
- Code generation backends (JS, Python, C++, ...)
- Generated schema library + small runtime (`@keyma/runtime-js`, ...)
- Database adapter of your choice (`@keyma/adapter-mongodb-js`, `@keyma/adapter-sqlite-js`, `@keyma/adapter-gremlin-js`, ...)
- Transport of your choice (HTTP, WebSocket, in-process, ...)

Decorators in the schema source are **compile-time annotations**, not runtime behavior. The Keyma compiler reads them from the AST. They are never executed and never emitted into the compiled output.

---

## Packages

Pipeline order (each package depends on the one above):

| Package | Role |
|---|---|
| [`@keyma/dsl`](packages/dsl) | Type-only authoring surface — decorators, semantic types, validator/formatter factories. |
| [`@keyma/validators`](packages/validators) · [`@keyma/formatters`](packages/formatters) | The built-in validator and formatter marker libraries. |
| [`@keyma/ir`](packages/ir) | The language-neutral IR types, JSON Schema, and intrinsic registry. |
| [`@keyma/compiler-frontend-ts`](packages/compiler-frontend-ts) | TypeScript frontend — parses schema files into IR. |
| [`@keyma/compiler`](packages/compiler) | Driver + plugin interfaces (`KeymaFrontend`, `KeymaBackend`). |
| [`@keyma/compiler-backend-js`](packages/compiler-backend-js) · [`@keyma/compiler-backend-python`](packages/compiler-backend-python) · [`@keyma/compiler-backend-cpp`](packages/compiler-backend-cpp) | Code-generation backends (JavaScript, Python, C++23). |
| [`@keyma/runtime-js`](packages/runtime-js) · [`@keyma/runtime-python`](packages/runtime-python) · [`@keyma/runtime-cpp`](packages/runtime-cpp) | Target runtimes — query builder, `KeymaServer`, adapter interface, plugin protocol (JS, Python, C++). |
| [`@keyma/adapter-mongodb-js`](packages/adapter-mongodb-js) · [`@keyma/adapter-sqlite-js`](packages/adapter-sqlite-js) · [`@keyma/adapter-gremlin-js`](packages/adapter-gremlin-js) | Database adapters. |
| [`@keyma/plugin-acl-js`](packages/plugin-acl-js) | Declarative access-control server plugin. |
| [`@keyma/cli`](packages/cli) | Project scaffolding and build orchestration. |
| [`@keyma/bench`](packages/bench) | Shared latency-benchmark harness for adapters. |

---

## Installation

```shell
npm i -g @keyma/cli
```

## Usage

First, generate a new project using the CLI.

```shell
keyma new my-project
cd my-project
```

This generates a new Keyma project and changes into the project directory. Now let's create a data model.

```shell
keyma gen user
```

A new file called **user.ts** will be created in the **src** directory and should look like this:

```typescript
import { Schema, ID } from "@keyma/dsl";

@Schema({
    name: "user",
})
export class User {
    readonly id: ID;
}
```

Let's add some fields with validation to our User model. Required-ness is inferred from the type — a non-optional field is required, so there is no `required` marker:

```typescript
import { Schema, ID, Validate } from "@keyma/dsl";
import { minLength, maxLength, isEmail } from "@keyma/validators";

@Schema({
    name: "user",
})
export class User {
    readonly id: ID;

    @Validate(minLength(2), maxLength(32))
    firstName: string;

    @Validate(minLength(2), maxLength(32))
    lastName: string;

    @Validate(isEmail())
    email: string;
}
```

We'll want to store users in a database, so we'll declare how it's indexed. We can also add internal fields:

```typescript
import { Schema, ID, Validate, Indexed } from "@keyma/dsl";
import { minLength, maxLength, isEmail } from "@keyma/validators";

@Schema({
    name: "user",
})
export class User {
    readonly id: ID;

    @Validate(minLength(2), maxLength(32))
    firstName: string;

    @Validate(minLength(2), maxLength(32))
    lastName: string;

    @Validate(isEmail())
    @Indexed({ unique: true })
    email: string;

    @Indexed()
    get fullName() {
        return `${this.firstName} ${this.lastName}`;
    }

    // `private` fields are detected by the compiler from the AST.
    // They are stripped from the generated client library and are not
    // settable from client input.
    private secretMessage: string;
}
```

The getter-only property `fullName` is treated as a **computed field**. Because it is `@Indexed()`, the compiler will:

* materialize its value on every write (the backend stores it as a real column/document field),
* expose it as an index in the generated server library,
* expose it as a normal getter on the client.

Computed getters must be expressible in Keyma's **portable expression subset** (field access, literals, template strings, basic operators, conditional expressions). The compiler emits a diagnostic if a getter uses unsupported constructs, so the same field can be generated correctly across all target languages.

Let's add formatting and form behavior:

```typescript
import { Schema, ID, Validate, Indexed, Format, Ephemeral } from "@keyma/dsl";
import { minLength, maxLength, isEmail } from "@keyma/validators";
import { trim, normalizeEmail } from "@keyma/formatters";

@Schema({
    name: "user",
})
export class User {
    readonly id: ID;

    @Validate(minLength(2), maxLength(32))
    @Format("change", trim())
    firstName: string;

    @Validate(minLength(2), maxLength(32))
    @Format("change", trim())
    lastName: string;

    @Validate(isEmail())
    @Indexed({ unique: true })
    @Format("change", normalizeEmail())
    email: string;

    @Indexed()
    get fullName() {
        return `${this.firstName} ${this.lastName}`;
    }

    @Ephemeral() // not stored in the database, but can go over the wire
    computedAtRuntime: string;

    private secretMessage: string;
}
```

References to other schemas use `Reference<T>` (stored ID, fetched separately) or `Embedded<T>` (inline sub-document). Schemas can be marked `private` to make them entirely server-only:

```typescript
import { Schema, ID, Indexed, Reference, Nullable } from "@keyma/dsl";

@Schema({
    name: "user_credentials",
    private: true, // server-only schema, not emitted in the client output
})
export class UserCredentials {
    readonly id: ID;

    @Indexed()
    user: Reference<User>;

    @Indexed()
    get username() {
        return this.user.email;
    }

    hashedPassword: string;
    totpRFC6238: Nullable<string>;
}
```

## Edges and graph traversals

Beyond plain references, Keyma supports first-class **edge schemas**: classes decorated with `@Edge(...)` whose endpoint fields are marked `@From()` and `@To()` declare a typed connection between two node schemas. The endpoint field's own type names the connected node schema (a bare class or `Reference<T>`), and `@From()`/`@To()` fields are indexed automatically. The edge's `name` doubles as its traversal label. Edges have their own fields, validators, and indexes, and they participate in `Keyma.traverse(...)` graph queries.

```typescript
import { Schema, Edge, From, To, ID } from "@keyma/dsl";

@Schema({ name: "person" })
export class Person {
    readonly id: ID;
    name: string;
}

@Schema({ name: "company" })
export class Company {
    readonly id: ID;
    name: string;
}

@Edge({ name: "knows", directed: false })
export class Knows {
    readonly id: ID;
    @From() from: Person;
    @To() to: Person;
    since: string;
}

@Edge({ name: "works_at" })
export class WorksAt {
    readonly id: ID;
    @From() from: Person;
    @To() to: Company;
    role: string;
}
```

When creating an edge, pass the node objects for `from`/`to` (each must carry its `id`); the server extracts the id. Reading an edge returns `from`/`to` as `{ id }` objects by default, and populates the connected node's fields when the query's projection asks for them.

You can then issue a typed, multi-hop traversal from any client. The same query runs on a graph database (native traversal), a document database (adapter-emulated lookups), or a relational database (adapter-emulated joins):

```typescript
// Companies of the people I know (heterogeneous chain).
const colleagues = Keyma.traverse(Company, {
    start: { schema: Person, where: { id: Keyma.input("me") } },
    steps: [
        { via: Knows,   direction: "out", edgeWhere: { since: { $gte: "2020-01-01" } } },
        { via: WorksAt, direction: "out", nodeWhere: { name: { $ne: "Acme" } } },
    ] as const,
    where: { /* terminal-node filter */ },
    emit: "nodes",
});

// People within 1..3 hops of me through `Knows` (homogeneous repeat).
const network = Keyma.traverse(Person, {
    start: { schema: Person, where: { id: Keyma.input("me") } },
    repeat: { via: Knows, direction: "out" },
    depth: { min: 1, max: 3 },
    emit: "nodes",
});
```

`Keyma.traverse` is fully type-checked: chain steps must agree on edge endpoints, and the terminal class (the first argument) determines the leaf type of the response. The terminal-node class is independent of `start.schema` — a chain that doesn't connect them in the requested directions is rejected at compile time (the type system narrows the inferred terminal to `never`).

Each step accepts two optional predicates:

* `edgeWhere` — filters edges of that hop on their own fields (e.g. `since` on `Knows`).
* `nodeWhere` — filters the node reached *via* that step, typed against that node's record type.

A top-level `where` on the traversal filters the terminal nodes.

The `emit` mode controls the result shape:

| `emit`    | Result element                                                         |
|-----------|------------------------------------------------------------------------|
| `"nodes"` | Terminal-node records (the default — typed as the terminal class).     |
| `"edges"` | Last-hop edge records.                                                 |
| `"paths"` | `{ nodes, edges }` per matched path — full witness for visualization.  |

Pagination and ordering apply to the emitted set via per-leaf `options`:

```typescript
await query.request({
    network: { skip: 0, limit: 50, sort: { name: 1 } },
}, { inputs, transport });
```

Adapters opt into traversals by setting `capabilities.traverse`. Graph databases lower the spec to a native traversal; document and relational adapters emulate it via `$lookup`-style joins. The client source is identical across backends — only the database adapter changes.

## Compiling

```shell
keyma build
```

By default, this produces:

```
dist/
  js/
    client/
      index.js
      index.d.ts
    server/
      index.js
      index.d.ts
.keyma/
  schema.ir.json
```

The generated JavaScript is plain ES modules. It contains:

* generated model classes (no decorators),
* static schema metadata objects,
* typed `.d.ts` files.

It depends only on the small `@keyma/runtime-js` runtime.

Backends are pluggable. Configure additional targets in `keyma.config.ts`:

```typescript
export default {
    source: "src/**/*.ts",
    outDir: "dist",
    targets: [
        { language: "js", client: true, server: true },
        { language: "python" },
        { language: "cpp", client: true, server: true }
    ]
};
```

## Multi-language targets

Every backend lowers the same IR, so the generated client/server split, validators, formatters, computed fields, edges, and traversals behave identically across languages. All three backends mirror the **source-file layout** — schemas authored in one source file are emitted into one model module — and emit validators/formatters as direct-ref factory functions with no name-keyed registry.

### Python (`@keyma/compiler-backend-python` + `@keyma/runtime-python`)

The Python backend mirrors the JS backend with Python-sanitized module names. The runtime is published to PyPI as **`keyma-runtime`** and imported as `keyma.runtime`.

* It is an `asyncio` mirror of the Promise-based JS runtime, with a `snake_case` surface (`apply_defaults`, `ensure_schema`, plugin hooks `transform_filter` / `check_write`, adapter `list` / `delete`, …).
* The schema-metadata **dict keys stay camelCase** (`sourceName`, `applyDefaults`, `fromField`) — that dict is the cross-language contract shared with the JS runtime.
* Validators/formatters are invoked **arity-adaptively**: the backend emits variable-arity closures, and the runtime truncates `(value, field, context)` to each callable's real arity and awaits awaitables. Three-arg validators receive a `Context` whose `.object` is the record dict, so cross-field validation works the same as in JS.

### C++23 (`@keyma/compiler-backend-cpp` + `@keyma/runtime-cpp`)

The C++ backend emits **header-only** model modules under `models/<path>`. Each generated struct is `std::pmr`-allocator-aware and specializes `keyma::value_traits<T>`, so the runtime's generic `keyma::from_value<T>` / `keyma::to_value<T>` own all per-field coercion and the per-struct code stays thin. Validators/formatters are direct-ref factory functions in `validators.hpp` / `formatters.hpp`.

`@keyma/runtime-cpp` is a C++23 header-only runtime whose single source of truth is `include/keyma/runtime.hpp` (`keyma::Value`, the schema-metadata structs, the intrinsics, the `value_traits` / `from_value` / `to_value` serialization layer, plus the `KeymaServer`, query builder, and adapter/plugin/service interfaces templated on a bring-your-own-scheduler async policy).

* **Runtime dependency is a deliberate exception.** Generated headers `#include <keyma/runtime.hpp>` by default — compile with `-I node_modules/@keyma/runtime-cpp/include`. A header-only runtime cannot be practically re-inlined per model header, so unlike the JS/Python output this target is not zero-dependency by default.
* **`vendorRuntime: true`** restores the zero-dependency property by baking a self-contained `keyma_runtime.hpp` into each bundle.
* **One bundle per translation unit.** A program/TU must include exactly one bundle — client *xor* server *xor* `library` (the single-bundle mode). The per-bundle `keyma::value_traits<T>` specializations make mixing two bundles in one TU an ODR violation by design.

C++ targets accept a few extra options alongside `client` / `server`:

```typescript
{
    language: "cpp",
    library: true,             // emit one combined bundle instead of client/server
    namespace: "app",          // root C++ namespace for generated code (default "app")
    vendorRuntime: true,       // inline keyma_runtime.hpp; no @keyma/runtime-cpp dependency
    runtimeInclude: "<keyma/runtime.hpp>" // include path when not vendoring
}
```

## Server-side implementation

The server-side library is consumed with the `@keyma/runtime-js` runtime and a database adapter. The adapter is the seam that makes Keyma database-agnostic — swap MongoDB for a graph or relational adapter and the schema and query code are unchanged:

```typescript
import { KeymaServer } from "@keyma/runtime-js";
import { MongoAdapter } from "@keyma/adapter-mongodb-js";
import { schemas } from "./generated/server";

const server = new KeymaServer({
    schemas,
    adapter: new MongoAdapter({ url: "mongodb://localhost:27017", db: "myapp" }),
});

await server.ensureSchemas(); // creates collections, indexes, and edge collections
```

To implement your own adapter for a different database, conform to the `KeymaDatabaseAdapter` interface exported from `@keyma/runtime-js`.

## Server plugins

Cross-cutting concerns — access control, auditing, soft-delete, multi-tenancy, rate-limiting — plug into `KeymaServer` through the **plugin protocol**, without modifying schemas or touching generated code. A plugin is a plain object implementing `KeymaServerPlugin`; an array of them is passed to the server:

```typescript
import { KeymaServer } from "@keyma/runtime-js";
import { createAclPlugin } from "@keyma/plugin-acl-js";

const server = new KeymaServer({
    schemas: mySchemas, // the ACL plugin registers its own schemas during init
    adapter,
    plugins: [createAclPlugin(), auditLog, multiTenant],
});
```

Plugins fire in array order at well-defined points in the operation lifecycle. Each hook is optional:

| Hook                  | When it runs                                                          | What it can do                                                                                  |
|-----------------------|-----------------------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| `init`                | Once after server construction.                                       | Inspect schemas / adapter via `PluginServerHandle`; register schemas; reject misconfiguration by throwing. |
| `transformOperation`  | First, before any other per-leaf hook.                               | Rewrite the whole operation (e.g. inject filters into a traversal spec).                         |
| `beforeOperation`     | Before any work on each leaf.                                         | Observe; early-reject with a `KeymaPluginError`.                                                |
| `transformFilter`     | On `list` / `read` / `update` / `delete` (also when computing trims). | Rewrite the `where` clause. Supports top-level `$and` / `$or` / `$nor` for layered policy.      |
| `transformProjection` | On every operation that produces a projection.                        | Trim the projection (security) or augment it (e.g. pull predicate fields the plugin needs).     |
| `checkWrite`          | On `create` / `update`, after default formatting and validation.      | Validate the payload; strip disallowed fields; throw `KeymaPluginError` for hard reject.        |
| `transformResult`     | On records leaving the server.                                        | Post-process — redact, decorate, decrypt, etc.                                                  |
| `afterOperation`      | After every operation regardless of outcome.                          | Observe for logging / metrics. Errors here are swallowed and cannot poison the response.        |

Plugins share state across hooks through a per-request `RequestContext`, an open-shaped object the host supplies via `server.handle(request, context)` or via the `contextFactory` argument to `createDirectTransport`. The runtime treats `context.identity` as the canonical identity slot (with optional `id`, `roles`, and an `isSystem` bypass flag plugins may honor), but plugins are free to stash any additional keys they need to thread state from `transformFilter` to `transformResult`.

### Error model

Throwing a `KeymaPluginError` from any hook (other than `afterOperation`) aborts the operation and produces a structured `KeymaLeafFailure` on the wire:

```json
{
    "ok": false,
    "code": "FORBIDDEN",
    "error": "No ACL rule grants list on post",
    "source": "plugin",
    "origin": "@keyma/plugin-acl-js"
}
```

`source` distinguishes plugin failures from `runtime` (validation, missing schema, NOT_FOUND) and `adapter` (database errors) failures; `origin` is the package name of the plugin that raised the error. The same `KeymaLeafFailure` shape is produced for adapter errors via `KeymaAdapterError`.

A worked example is `@keyma/plugin-acl-js`, which uses `transformFilter` to merge per-identity allow/deny predicates into the caller's `where`, `transformProjection` to enforce field-level read perms (and to pull predicate fields the adapter needs), `checkWrite` to enforce field-level write perms, `transformResult` to strip plugin-added projection fields, and `transformOperation` to inject read predicates into traversals.

## Transports

The client side talks to the server through a `Transport` — a function `(request) => Promise<response>`. Keyma never assumes HTTP. Provide whatever fits your environment:

```typescript
import { createDirectTransport } from "@keyma/runtime-js";

// In-process (e.g. SSR, tests): hand requests directly to a KeymaServer.
const transport = createDirectTransport(server);

// Or supply your own HTTP/WebSocket/gRPC/message-bus transport:
const transport: Transport = async (request) => {
    const res = await fetch("/api/keyma", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
    });
    return res.json();
};
```

## Querying data

The client builds typed, declarative queries against the generated schemas. Queries serialize to a portable, language-neutral request document and are dispatched through your transport — so any Keyma client runtime, in any language, can issue them against any compatible server.

```typescript
// Build a query template
const query = Keyma.query({
    users: Keyma.list(User, /* where: */{
        email: Keyma.input("emailSearch"), // placeholder for request-time substitution
        active: true,                      // static value, fixed at template time
    }, /* projection: */{
        id: 1,
        email: 1,
        firstName: 1,
        lastName: 1,
    }),
    user: Keyma.read(User, /* where: */{
        id: Keyma.input("userId"),
    }, /* projection: */{
        id: 1,
        email: 1,
        firstName: 1,
        lastName: 1,
        createdOn: 1,
    }),
});

async function listUsers(skip: number, limit: number, inputs: typeof query.inputs) {
    const response = await query.request({
        users: {
            skip,
            limit,
            sort: { createdOn: -1 },
        },
        user: {}, // empty options for this leaf, can be omitted
    }, { inputs, transport });

    return response;
}
```

The same `Keyma.query` document can mix CRUD operations and graph traversals in a single batch, returning a typed, projected response shape.

## Why a compiler, not runtime decorators?

Traditional decorator-based TypeScript schema libraries depend on `reflect-metadata`, decorator emit helpers, and `tslib`. They cannot:

* reliably detect `private` fields,
* emit type metadata for generics,
* generate code for non-JavaScript runtimes,
* fully separate client and server output,
* statically validate computed expressions for portability,
* produce dependency-free generated libraries.

Keyma sidesteps all of those limitations by treating TypeScript as an authoring DSL and generating plain, statically-defined libraries from a stable IR.

## Development

npm workspaces monorepo. All packages live under `packages/*` and publish under the `@keyma/*` scope.

```bash
npm run build                                   # build every workspace
npm run test                                    # test every workspace
npm -w @keyma/compiler-frontend-ts run build    # build a single package
npm -w @keyma/compiler-frontend-ts run test     # build + test a single package
```

Tests use Node's built-in test runner (`node --test`): each package compiles its TypeScript to `dist/test/` first, then runs the compiled `.test.js` files.

## Status

Keyma is under active development.

## License

MIT

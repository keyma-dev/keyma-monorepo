# @keyma/adapter-gremlin-js

A Keyma database adapter for **Apache TinkerPop / Gremlin** graph databases —
TinkerGraph, Amazon Neptune, JanusGraph, and other Gremlin-enabled stores
(including Neo4j via its Gremlin plugin). It implements the same
`KeymaDatabaseAdapter` contract as `@keyma/adapter-mongodb-js`, so it is a
drop-in swap in `KeymaServer`.

It talks to the server through a `GraphTraversalSource` using **bytecode GLV**
(the fluent `g.V()…` API) for maximum portability — no Groovy script strings or
lambdas.

## Usage

```ts
import gremlin from "gremlin";
import { KeymaServer, createDirectTransport } from "@keyma/runtime-js";
import { GremlinAdapter } from "@keyma/adapter-gremlin-js";

const adapter = new GremlinAdapter(
    () => new gremlin.driver.DriverRemoteConnection("ws://localhost:8182/gremlin"),
);
const server = new KeymaServer({ schemas, adapter });
const transport = createDirectTransport(server);

// …on shutdown:
await server.close(); // delegates to adapter.close()
```

The adapter **owns its connection**. You pass a *factory* that builds a
`DriverRemoteConnection`; the adapter connects lazily on first use, rebuilds the
connection (retrying the operation once) if it fails with a connection-level
error, and — if you set `maxConnectionAgeMs` — proactively rebuilds it before
that age elapses. `connect()` (called by `KeymaServer` during init) and
`close()` are exposed for explicit lifecycle control.

### Amazon Neptune

Neptune's IAM auth requires SigV4-signed headers computed per connection, and
those credentials expire. Sign them **inside the factory** so every rebuilt
connection carries fresh headers, and set `maxConnectionAgeMs` below the
credential lifetime:

```ts
const adapter = new GremlinAdapter(
    () => new gremlin.driver.DriverRemoteConnection(NEPTUNE_WSS_URL, {
        headers: signSigV4Headers(), // your SigV4 signing, recomputed each call
    }),
    { maxConnectionAgeMs: 9 * 60_000 }, // refresh before tokens expire
);
```

### Options

- `label(schema)` — vertex label for a schema (default `schema.name`).
- `edgeLabel(schema)` — Gremlin edge label for an `@Edge` schema (default
  `schema.name`; must agree across create and traverse).
- `generateId()` — id generator used when a record is created without an `id`
  (default `crypto.randomUUID()`).
- `maxConnectionAgeMs` — proactively rebuild the connection once it has been open
  this long (default: keep one connection until it errors). Use it for Neptune
  SigV4 expiry.

## Data model

- **Non-edge schemas → vertices.** Fields become vertex properties.
- **`@Edge` schemas → real edges.** The `from`/`to` field values identify the
  endpoint vertices; other fields become edge properties. Edges drive
  `traverse()`.
- **`id` → the element's `T.id`** (not a property). Lookups use `hasId(...)`.
- **`Reference<T>` → the target id stored as a property**, resolved on demand by
  `populate` (a vertex lookup). Edges are reserved for `@Edge` schemas.
- **`Embedded<T>` → dotted property keys** (`address.city`) so sub-fields stay
  queryable; re-nested on read.
- **Arrays → list-cardinality multi-properties** (order-preserving on
  TinkerGraph; Neptune uses set cardinality and does not preserve order). Array
  elements on edges (which can't hold multi-properties) are JSON-encoded.
- Scalars: `bigint`/`decimal` are stored as strings, dates as ISO-8601 strings,
  bytes as base64.

## Known limitations

- **Range queries on `bigint`/`decimal`** are not supported (they are stored as
  strings; equality and `$in`/`$nin` work). `number`/`integer` and ISO dates
  sort/range correctly.
- **`populate` runs in a single traversal** via `project()` with sub-traversals
  that follow each stored reference id to its target vertex (array references
  and nested populate included) — no per-reference round-trip. Because
  references are id properties rather than edges, the in-traversal lookup is not
  served by the vertex id index, so very large graphs may prefer modeling those
  relationships as `@Edge` schemas.
- **Identity portability:** ids are supplied as `T.id`. TinkerGraph (with an
  `ANY` id manager) and Neptune honor user-supplied string ids; backends that
  ignore them (e.g. JanusGraph) assign their own, which the adapter reads back
  and returns. Configure your graph's id manager to accept strings — e.g.
  TinkerGraph `gremlin.tinkergraph.vertexIdManager=ANY`.
- **Indexes:** Gremlin has no portable index DDL, so `ensureSchema` performs
  none — configure indexes on the server.
- **Reconnect retries assume idempotency.** On a detected connection-level
  failure the adapter rebuilds the connection and retries the operation once.
  Reads, updates, and deletes are naturally idempotent; `create` resolves the
  element id once (before the retry) and supplies it as `T.id`, so a retried
  insert reuses that id rather than minting a new one — and `maxConnectionAgeMs`
  keeps the window for a mid-write drop small.

## Testing

Translation/value-mapping unit tests run with no server. Integration tests run
only when `GREMLIN_ENDPOINT` is set and are skipped otherwise:

```bash
docker run -d -p 8182:8182 \
  -v "$PWD/test/tinkergraph-any.properties:/opt/gremlin-server/conf/tinkergraph-empty.properties" \
  tinkerpop/gremlin-server:latest
GREMLIN_ENDPOINT=ws://127.0.0.1:8182/gremlin npm -w @keyma/adapter-gremlin-js test
```

(The mounted properties file just sets the TinkerGraph id managers to `ANY` so
string ids are accepted.)

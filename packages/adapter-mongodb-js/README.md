# @keyma/adapter-mongodb-js

A MongoDB `KeymaDatabaseAdapter` for `@keyma/runtime-js`. It implements the same contract as the other adapters (`@keyma/adapter-sqlite-js`, `@keyma/adapter-gremlin-js`), so it is a drop-in swap in `KeymaServer` — the schema and query code never change.

## Usage

```ts
import { KeymaServer, createDirectTransport } from "@keyma/runtime-js";
import { MongoAdapter } from "@keyma/adapter-mongodb-js";
import { schemas } from "./generated/server";

const adapter = new MongoAdapter({ url: "mongodb://localhost:27017", db: "myapp" });
const server = new KeymaServer({ schemas, adapter });

await server.ensureSchemas();          // creates collections and indexes
const transport = createDirectTransport(server);

// …on shutdown:
await server.close();                  // closes the MongoClient the adapter owns
```

The adapter **owns its `MongoClient`**: it connects lazily on first use and closes when `server.close()` (→ `adapter.close()`) runs.

### Options (`MongoAdapterOptions`)

| Option | Type | Default |
|---|---|---|
| `url` | `string` (required) | — |
| `db` | `string` (required) | — |
| `collectionName` | `(schema) => string` | `schema.name` |
| `generateId` | `() => string` | `new ObjectId().toHexString()` |
| `client` | `MongoClientOptions` | — (forwarded to the owned `MongoClient`) |

### Capabilities

```ts
{ traverse: { maxDepth: 100, emitPaths: true, heterogeneous: true } }
```

## Data model

- **Non-edge schemas → collections**; records → documents.
- **`id` ↔ `_id`.** Stored as an `ObjectId`, surfaced to Keyma as a hex string. When a record is created without an `id`, `generateId()` supplies one.
- **`Reference<T>` →** the target id stored as a field; resolved on demand with `$lookup` when a projection asks to populate it.
- **`Embedded<T>` →** a nested sub-document, queryable via dot paths (`address.city`).
- **Arrays →** BSON arrays.
- **`@Edge` schemas →** documents whose endpoint fields hold the connected ids; traversals walk them with `$lookup` / `$graphLookup`.
- **Indexes →** `ensureSchema()` creates per-field and composite indexes via `createIndexes()`. The `id` field is skipped — MongoDB's implicit unique `_id` index covers it.
- **Scalars:** `bigint → Long`, `decimal → Decimal128`, `bytes → Binary`, `dateTime → Date`.

## Traversals

- **Heterogeneous step chains** (multi-hop, mixed node/edge types) lower to chained `$lookup` stages.
- **Homogeneous repeats** (`repeat` with `depth` bounds) lower to `$graphLookup`.
- **`emit` modes:** `"nodes"`, `"edges"`, `"paths"`.

Known limitations:

- **`repeat.nodeWhere` is not honored** — `$graphLookup` cannot filter intermediate nodes mid-traversal. Use a step chain when you need per-hop node filters; `edgeWhere` *is* honored.
- **`emit: "paths"` with a repeat traversal** is computed by unrolling one chained-`$lookup` pipeline per depth in `[min, max]` and unioning the results.
- **Range queries** work natively on `number`/`integer`/`dateTime`; `bigint`/`decimal` round-trip through `Long`/`Decimal128`.

## Filter shape

Every `where` follows Keyma's canonical adapter filter shape — field equality or operator objects (`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`/`$in`/`$nin`), plus top-level `$and`/`$or`/`$nor`. Values are converted per field type (e.g. an `id` string becomes an `ObjectId`).

## Testing

Tests run against an in-memory server (`mongodb-memory-server`) — no external MongoDB required:

```bash
npm -w @keyma/adapter-mongodb-js test
```

A latency benchmark (built on `@keyma/bench`) runs against the in-memory server, or a real one via `KEYMA_BENCH_MONGO_URI`:

```bash
KEYMA_BENCH_MONGO_URI=mongodb://localhost:27017 npm -w @keyma/adapter-mongodb-js run bench
```

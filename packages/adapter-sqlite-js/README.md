# @keyma/adapter-sqlite-js

A SQLite `KeymaDatabaseAdapter` for `@keyma/runtime-js`, built on [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) and [Kysely](https://kysely.dev/). It implements the same contract as the other adapters, so it is a drop-in swap in `KeymaServer`.

## Usage

```ts
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { KeymaServer, createDirectTransport } from "@keyma/runtime-js";
import { SqliteAdapter } from "@keyma/adapter-sqlite-js";
import { schemas } from "./generated/server";

const sqlite = new Database("app.db");
sqlite.pragma("foreign_keys = ON");
const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });

const adapter = new SqliteAdapter(db);
const server = new KeymaServer({ schemas, adapter });

await server.ensureSchemas();          // CREATE TABLE IF NOT EXISTS + indexes
const transport = createDirectTransport(server);
```

You construct and own the Kysely/better-sqlite3 connection and pass it in — use `":memory:"` for tests. Enable `foreign_keys` so reference constraints are enforced.

### Options (`SqliteAdapterOptions`)

| Option | Type | Default |
|---|---|---|
| `tableName` | `(schema) => string` | `schema.name` |
| `generateId` | `() => string` | `crypto.randomUUID()` |

### Capabilities

```ts
{ traverse: { maxDepth: 100, emitPaths: true, heterogeneous: true } }
```

## Data model

- **Each schema → a table; each field → a column.** `ensureSchema()` emits `CREATE TABLE IF NOT EXISTS` plus `CREATE [UNIQUE] INDEX` DDL.
- **`id` → `TEXT PRIMARY KEY`.** `generateId()` fills it on create when absent.
- **`Reference<T>` →** a `TEXT` column holding the target id, with a `FOREIGN KEY` to the target table.
- **`Embedded<T>` and arrays →** JSON-encoded `TEXT`, decoded back to objects/arrays on read.
- **`@Edge` schemas →** ordinary tables, one row per edge; the endpoint columns are foreign keys.
- **Column types:** `string`/`decimal`/`bigint`/`date`/`dateTime`/`time`/`json → TEXT`; `integer`/`boolean → INTEGER` (booleans as `0`/`1`); `number → REAL`; `bytes → BLOB`; `enum → TEXT` with a `CHECK` constraint.

## Traversals

- **Heterogeneous step chains** lower to `INNER JOIN`s across the edge and node tables.
- **Homogeneous repeats** lower to a **recursive CTE** with depth bounds and per-path cycle detection (`json_each` over the visited-id path).
- **`emit` modes:** `"nodes"`, `"edges"`, `"paths"`.

Known limitations:

- **`repeat` with `direction: "both"`** is not implemented (rejected with `SqliteAdapterInvalidQuery`); use `"out"`/`"in"`, or a step chain.
- **`emit: "paths"` with a repeat traversal** falls back to one step-chain query per depth.
- **JSON-encoded array/embedded columns** are not independently indexable or filterable by element.
- **`populate` is one level deep.**

## Filter shape

Every `where` follows Keyma's canonical adapter filter shape — field equality or operator objects (`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`/`$in`/`$nin`), plus top-level `$and`/`$or`/`$nor`.

## Testing

```bash
npm -w @keyma/adapter-sqlite-js test       # in-memory SQLite, no external DB
npm -w @keyma/adapter-sqlite-js run bench   # latency benchmark via @keyma/bench
```

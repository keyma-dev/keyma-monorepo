# @keyma/bench

A shared **latency-benchmark harness** for Keyma database adapters. It defines a fixed set of CRUD, populate, and traversal scenarios, runs them against any `KeymaDatabaseAdapter`, and reports per-operation latency percentiles. `@keyma/adapter-mongodb-js` and `@keyma/adapter-sqlite-js` both drive it, so their numbers are directly comparable.

It is **dev-only**: a `peerDependency` on `@keyma/runtime-js`, consumed from an adapter's `bench/` script rather than shipped to applications.

## Public API

```ts
import {
    runBenchmark, printTable, writeResult, readResult,
    compareResults, printComparison, summarize,
} from "@keyma/bench";
```

| Export | Description |
|---|---|
| `runBenchmark(adapter, opts)` | Runs every scenario (or a filtered subset) against `adapter`; returns a `BenchResult`. |
| `printTable(result)` | Prints a `BenchResult` as an aligned ASCII table. |
| `writeResult(result, dir)` | Writes a `BenchResult` as JSON into `dir`; returns the file path. |
| `readResult(path)` | Reads a `BenchResult` JSON file. |
| `compareResults(a, b)` / `printComparison(a, b)` | Diff two runs — delta and ratio per scenario. |
| `summarize(samples_ms)` | Percentile stats (`mean`/`p50`/`p95`/`p99`/`min`/`max`) for a latency sample array. |

It also exports the schemas the scenarios run against — `USER_SCHEMA`, `ORG_SCHEMA`, `POST_SCHEMA`, `TAG_SCHEMA`, `AUTHORSHIP_SCHEMA`, `TAGGING_SCHEMA`, `FRIENDSHIP_SCHEMA`, and `ALL_SCHEMAS`.

### `RunOptions`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `adapterName` | `string` | — (required) | Label recorded in the result. |
| `adapterVersion` | `string` | — | Optional version label. |
| `datasetSize` | `number` | `10_000` | Rows seeded for read/update/delete/traverse scenarios. |
| `reset()` | `() => Promise<void>` | — (required) | Clears **all** adapter state; run before each scenario's setup. |
| `only` | `readonly string[]` | run all | Restrict to named scenarios. |
| `onScenarioStart` / `onScenarioEnd` | callbacks | — | Progress hooks (typically print to stderr). |

Each scenario warms up, then times a fixed number of iterations with `process.hrtime.bigint()` and reports `mean`/`p50`/`p95`/`p99`/`min`/`max` in milliseconds. A scenario whose `setup` throws is recorded as **skipped** rather than aborting the run.

### Scenarios

CRUD by id, indexed-filter and sort+limit lists, single-level populate, 2- and 3-hop heterogeneous traversals, and a depth-3 homogeneous repeat traversal — eleven in all, defined once so every adapter is measured identically.

## Wiring it into an adapter

Each adapter ships a `bench/run.ts` that constructs its adapter, supplies a `reset`, and calls `runBenchmark`:

```ts
import { runBenchmark, printTable, writeResult } from "@keyma/bench";
import { MyAdapter } from "../src/index.js";

const adapter = new MyAdapter(/* … */);
const datasetSize = Number(process.env["KEYMA_BENCH_N"] ?? 10_000);
const only = process.env["KEYMA_BENCH_ONLY"]?.split(",").map((s) => s.trim()).filter(Boolean);

const result = await runBenchmark(adapter, {
    adapterName: "@keyma/adapter-mydb-js",
    datasetSize,
    ...(only ? { only } : {}),
    reset: async () => {
        /* drop every table / collection */
    },
    onScenarioStart: (s) => process.stderr.write(`${s.name} ... `),
    onScenarioEnd: (r) =>
        process.stderr.write(
            r.skipped ? `skipped (${r.skipped.reason})\n` : `${r.mean_ms.toFixed(2)} ms\n`,
        ),
});

await writeResult(result, "bench-results");
printTable(result);
```

Run it with `npm run bench`. By convention the run script maps these environment variables onto `RunOptions`:

| Variable | Meaning | Default |
|---|---|---|
| `KEYMA_BENCH_N` | Dataset size. | `10_000` |
| `KEYMA_BENCH_ONLY` | Comma-separated scenario names to run. | all |

`@keyma/bench` itself reads no environment variables — the adapter's run script does, and translates them into `RunOptions`.

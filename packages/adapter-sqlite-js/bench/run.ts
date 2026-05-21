import * as path from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { printTable, runBenchmark, writeResult } from "@keyma/bench";
import { SqliteAdapter } from "../src/index.js";
import type { AnyDb } from "../src/kysely.js";

async function cleanAll(raw: Database.Database): Promise<void> {
    raw.pragma("foreign_keys = OFF");
    try {
        const rows = raw
            .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
            .all() as { name: string }[];
        for (const r of rows) {
            raw.exec(`DROP TABLE IF EXISTS "${r.name}"`);
        }
    } finally {
        raw.pragma("foreign_keys = ON");
    }
}

async function main(): Promise<void> {
    const raw = new Database(":memory:");
    raw.pragma("journal_mode = WAL");
    raw.pragma("synchronous = NORMAL");
    raw.pragma("foreign_keys = ON");
    const db = new Kysely({ dialect: new SqliteDialect({ database: raw }) }) as AnyDb;
    const adapter = new SqliteAdapter(db);

    const datasetSize = Number(process.env["KEYMA_BENCH_N"] ?? 10_000);
    const only = process.env["KEYMA_BENCH_ONLY"]?.split(",").map((s) => s.trim()).filter(Boolean);

    try {
        const result = await runBenchmark(adapter, {
            adapterName: "@keyma/adapter-sqlite-js",
            datasetSize,
            ...(only !== undefined && only.length > 0 ? { only } : {}),
            reset: () => cleanAll(raw),
            onScenarioStart: (s) => process.stderr.write(s.name + " ... "),
            onScenarioEnd: (r) => {
                if (r.skipped !== undefined) {
                    process.stderr.write("skipped (" + r.skipped.reason + ")\n");
                } else {
                    process.stderr.write("mean " + r.mean_ms.toFixed(2) + " ms\n");
                }
            },
        });

        const outDir = path.join(process.cwd(), "bench-results");
        const fpath = await writeResult(result, outDir);
        printTable(result);
        process.stderr.write("\nwrote " + fpath + "\n");
    } finally {
        await db.destroy();
    }
}

await main();

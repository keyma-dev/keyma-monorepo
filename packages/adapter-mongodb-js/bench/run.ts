import * as path from "node:path";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { printTable, runBenchmark, writeResult } from "@keyma/bench";
import { MongoAdapter } from "../src/index.js";

async function clean(db: Db): Promise<void> {
    const cols = await db.listCollections().toArray();
    for (const c of cols) {
        await db.collection(c.name).drop().catch(() => undefined);
    }
}

const DB_NAME = "keyma_bench";

async function main(): Promise<void> {
    const envUri = process.env["KEYMA_BENCH_MONGO_URI"];
    let memory: MongoMemoryServer | undefined;
    let uri: string;
    if (envUri !== undefined && envUri.length > 0) {
        uri = envUri;
    } else {
        memory = await MongoMemoryServer.create();
        uri = memory.getUri();
    }
    // The adapter owns its own connection; this client is only used for reset.
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(DB_NAME);
    const adapter = new MongoAdapter({ url: uri, db: DB_NAME });

    const datasetSize = Number(process.env["KEYMA_BENCH_N"] ?? 10_000);
    const only = process.env["KEYMA_BENCH_ONLY"]?.split(",").map((s) => s.trim()).filter(Boolean);

    try {
        const result = await runBenchmark(adapter, {
            adapterName: "@keyma/adapter-mongodb-js",
            datasetSize,
            ...(only !== undefined && only.length > 0 ? { only } : {}),
            reset: () => clean(db),
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
        await adapter.close();
        await client.close();
        if (memory !== undefined) await memory.stop();
    }
}

await main();

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

async function main(): Promise<void> {
    const uri = process.env["KEYMA_BENCH_MONGO_URI"];
    let memory: MongoMemoryServer | undefined;
    let client: MongoClient;
    if (uri !== undefined && uri.length > 0) {
        client = new MongoClient(uri);
    } else {
        memory = await MongoMemoryServer.create();
        client = new MongoClient(memory.getUri());
    }
    await client.connect();
    const db = client.db("keyma_bench");
    const adapter = new MongoAdapter(db);

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
        await client.close();
        if (memory !== undefined) await memory.stop();
    }
}

await main();

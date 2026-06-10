import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";

export const DB_NAME = "keyma_test";

export type TestHandle = {
    mongo: MongoMemoryServer;
    uri: string;
    /** A client owned by the test harness, used only for cleanup between tests.
     *  The adapter under test owns its own client (built from `uri`/`DB_NAME`). */
    client: MongoClient;
    db: Db;
};

export async function startMongo(): Promise<TestHandle> {
    const mongo = await MongoMemoryServer.create();
    const uri = mongo.getUri();
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(DB_NAME);
    return { mongo, uri, client, db };
}

export async function stopMongo(h: TestHandle): Promise<void> {
    await h.client.close();
    await h.mongo.stop();
}

export async function clean(h: TestHandle): Promise<void> {
    const cols = await h.db.listCollections().toArray();
    for (const c of cols) {
        await h.db.collection(c.name).drop().catch(() => undefined);
    }
}

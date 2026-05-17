import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";

export type TestHandle = {
    mongo: MongoMemoryServer;
    client: MongoClient;
    db: Db;
};

export async function startMongo(): Promise<TestHandle> {
    const mongo = await MongoMemoryServer.create();
    const client = new MongoClient(mongo.getUri());
    await client.connect();
    const db = client.db("keyma_test");
    return { mongo, client, db };
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

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { AnyDb } from "../src/kysely.js";

export type TestHandle = {
    raw: Database.Database;
    db: AnyDb;
};

export function startSqlite(): TestHandle {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    const db = new Kysely({ dialect: new SqliteDialect({ database: raw }) }) as AnyDb;
    return { raw, db };
}

export async function stopSqlite(h: TestHandle): Promise<void> {
    await h.db.destroy();
}

export async function clean(h: TestHandle): Promise<void> {
    // Briefly disable FK enforcement so DROP TABLE doesn't fail on referenced
    // tables; tests can re-enable per-call if they need to assert FK violations.
    h.raw.pragma("foreign_keys = OFF");
    try {
        const rows = h.raw
            .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
            .all() as { name: string }[];
        for (const r of rows) {
            h.raw.exec(`DROP TABLE IF EXISTS "${r.name}"`);
        }
    } finally {
        h.raw.pragma("foreign_keys = ON");
    }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TagManifest } from "@keyma/ir";

// Real-filesystem I/O for the committed binary tag manifest (`keyma.tags.json`). The CLI is
// the ONLY layer that touches the manifest on disk — it is read before `drive()` and written
// back (idempotently) after a clean build, threading through the pure compiler as data only.

/** Read the committed manifest, or `undefined` if it does not exist yet (first compile). */
export function readTagManifest(path: string): TagManifest | undefined {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf-8")) as TagManifest;
}

/** Stable serialization (sorted schema keys + sorted field keys) so writes are deterministic
 *  and diffs are reviewable. */
export function serializeTagManifest(manifest: TagManifest): string {
    const schemas: Record<string, unknown> = {};
    for (const name of Object.keys(manifest.schemas).sort()) {
        const entry = manifest.schemas[name]!;
        const fields: Record<string, number> = {};
        for (const f of Object.keys(entry.fields).sort()) fields[f] = entry.fields[f]!;
        schemas[name] = {
            nextTag: entry.nextTag,
            fields,
            tombstones: [...entry.tombstones].sort((a, b) => a - b),
        };
    }
    return JSON.stringify({ manifestVersion: manifest.manifestVersion, schemas }, null, 2) + "\n";
}

/** Write the manifest only when its serialized content changed (idempotent — avoids churning
 *  git and, under `watch`, retriggering a rebuild). Returns true iff the file was written. */
export function writeTagManifestIfChanged(path: string, manifest: TagManifest): boolean {
    const next = serializeTagManifest(manifest);
    if (existsSync(path) && readFileSync(path, "utf-8") === next) return false;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next, "utf-8");
    return true;
}

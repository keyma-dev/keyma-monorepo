import type { IndexDescription } from "mongodb";
import type { SchemaMetadata } from "@keyma/runtime-js";

/** Build a `createIndexes` spec from a schema's `indexes` (compound) and per-
 *  field `indexes` (single-field) metadata. `id` field names are mapped to
 *  `_id` in the key spec. */
export function buildIndexes(schema: SchemaMetadata): IndexDescription[] {
    const out: IndexDescription[] = [];
    for (const field of schema.fields) {
        if (field.indexes === undefined) continue;
        // MongoDB creates an implicit unique index on _id; defining additional
        // indexes for it is rejected. Skip user-declared indexes on `id`.
        if (field.name === "id") continue;
        for (const idx of field.indexes) {
            const dir = idx.direction ?? 1;
            const desc: IndexDescription = { key: { [field.name]: dir } };
            if (idx.unique === true) desc.unique = true;
            if (idx.sparse === true) desc.sparse = true;
            if (idx.key !== undefined) desc.name = idx.key;
            out.push(desc);
        }
    }
    if (schema.indexes !== undefined) {
        for (const idx of schema.indexes) {
            const key: Record<string, 1 | -1 | "text"> = {};
            for (const f of idx.fields) {
                key[f.name === "id" ? "_id" : f.name] = f.direction;
            }
            const desc: IndexDescription = { key };
            if (idx.unique === true) desc.unique = true;
            if (idx.sparse === true) desc.sparse = true;
            if (idx.name !== undefined) desc.name = idx.name;
            out.push(desc);
        }
    }
    return out;
}

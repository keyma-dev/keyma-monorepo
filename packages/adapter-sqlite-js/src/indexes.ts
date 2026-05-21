import type { FieldIndex, SchemaIndex, SchemaMetadata } from "@keyma/runtime-js";

/** Emit `CREATE INDEX` statements for a schema's field-level and
 *  schema-level indexes. SQLite auto-creates the index for `PRIMARY KEY`,
 *  so user-declared indexes on `id` are skipped. */
export function buildIndexStatements(schema: SchemaMetadata): string[] {
    const out: string[] = [];
    for (const field of schema.fields) {
        if (field.indexes === undefined) continue;
        if (field.name === "id") continue;
        for (const idx of field.indexes) {
            out.push(fieldIndexStatement(schema.name, field.name, idx));
        }
    }
    if (schema.indexes !== undefined) {
        for (const idx of schema.indexes) {
            out.push(schemaIndexStatement(schema.name, idx));
        }
    }
    return out;
}

function fieldIndexStatement(table: string, column: string, idx: FieldIndex): string {
    const name = idx.key ?? `${table}__${column}__idx`;
    const unique = idx.unique === true ? "UNIQUE " : "";
    const direction = idx.direction === -1 ? " DESC" : "";
    const where = idx.sparse === true ? ` WHERE ${q(column)} IS NOT NULL` : "";
    return (
        `CREATE ${unique}INDEX IF NOT EXISTS ${q(name)} ON ${q(table)} (${q(column)}${direction})${where}`
    );
}

function schemaIndexStatement(table: string, idx: SchemaIndex): string {
    const cols = idx.fields
        .map((f) => {
            const col = f.name === "id" ? "id" : f.name;
            const dir = f.direction === -1 ? " DESC" : "";
            return q(col) + dir;
        })
        .join(", ");
    const colNames = idx.fields.map((f) => f.name).join("_");
    const name = idx.name ?? `${table}__${colNames}__idx`;
    const unique = idx.unique === true ? "UNIQUE " : "";
    return `CREATE ${unique}INDEX IF NOT EXISTS ${q(name)} ON ${q(table)} (${cols})`;
}

function q(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
}

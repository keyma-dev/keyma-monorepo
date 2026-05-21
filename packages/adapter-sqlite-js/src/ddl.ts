import type { FieldMetadata, FieldType, SchemaMetadata } from "@keyma/runtime-js";
import { SqliteAdapterInvalidQuery } from "./errors.js";

export function buildCreateTable(schema: SchemaMetadata): string {
    const cols: string[] = [];
    const constraints: string[] = [];
    let idColumn: string | undefined;

    for (const field of schema.fields) {
        if (isComputedOrEphemeral(field)) continue;
        const { sql, isId, refSchema } = columnDef(field);
        cols.push(sql);
        if (isId) idColumn = field.name;
        if (refSchema !== undefined) {
            constraints.push(
                "FOREIGN KEY (" + q(field.name) + ") REFERENCES " + q(refSchema) + "(" + q("id") + ")",
            );
        }
    }

    if (idColumn === undefined) {
        throw new SqliteAdapterInvalidQuery(
            `Schema "${schema.name}" has no field of kind "id"; SQLite adapter requires one.`,
        );
    }

    const lines = [...cols, ...constraints];
    return (
        "CREATE TABLE IF NOT EXISTS " + q(schema.name) + " (\n    "
        + lines.join(",\n    ")
        + "\n)"
    );
}

function isComputedOrEphemeral(field: FieldMetadata): boolean {
    return field.computed === true || field.ephemeral === true;
}

type ColumnDef = { sql: string; isId: boolean; refSchema?: string };

function columnDef(field: FieldMetadata): ColumnDef {
    const { type, isId, refSchema, nullable } = inspectType(field.type);
    const sqlType = sqliteColumnType(type);
    const parts: string[] = [q(field.name), sqlType];
    if (isId) {
        parts.push("PRIMARY KEY NOT NULL");
    } else if (!nullable && field.required !== false) {
        parts.push("NOT NULL");
    }
    if (type.kind === "enum") {
        const list = type.values.map((v) => "'" + v.replace(/'/g, "''") + "'").join(", ");
        parts.push("CHECK (" + q(field.name) + " IN (" + list + "))");
    }
    const out: ColumnDef = { sql: parts.join(" "), isId };
    if (refSchema !== undefined) out.refSchema = refSchema;
    return out;
}

type InspectedType = {
    /** Effective leaf type after unwrapping nullable. Array stays as array.  */
    type: FieldType;
    isId: boolean;
    refSchema?: string;
    nullable: boolean;
};

function inspectType(t: FieldType): InspectedType {
    let nullable = false;
    let cur: FieldType = t;
    while (cur.kind === "nullable") {
        nullable = true;
        cur = cur.of;
    }
    if (cur.kind === "id") return { type: cur, isId: true, nullable };
    if (cur.kind === "reference") {
        return { type: cur, isId: false, refSchema: cur.schema, nullable };
    }
    return { type: cur, isId: false, nullable };
}

export function sqliteColumnType(type: FieldType): string {
    switch (type.kind) {
        case "id":
        case "string":
        case "enum":
        case "reference":
        case "bigint":
        case "decimal":
        case "date":
        case "dateTime":
        case "time":
        case "json":
        case "embedded":
        case "array":
            return "TEXT";
        case "integer":
        case "boolean":
            return "INTEGER";
        case "number":
            return "REAL";
        case "bytes":
            return "BLOB";
        case "nullable":
            return sqliteColumnType(type.of);
    }
}

function q(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
}

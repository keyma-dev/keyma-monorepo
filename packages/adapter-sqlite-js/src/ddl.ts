import type { FieldMetadata, FieldType, SchemaMetadata } from "@keyma/runtime/schema";
import { SqliteAdapterInvalidQuery } from "./errors.js";

export function buildCreateTable(schema: SchemaMetadata): string {
    const cols: string[] = [];
    const constraints: string[] = [];
    let idColumn: string | undefined;

    for (const field of schema.fields) {
        if (isEphemeral(field)) continue;
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

function isEphemeral(field: FieldMetadata): boolean {
    return field.ephemeral === true;
}

type ColumnDef = { sql: string; isId: boolean; refSchema?: string };

function columnDef(field: FieldMetadata): ColumnDef {
    const { type, isId, refSchema } = inspectType(field.type);
    const sqlType = sqliteColumnType(type);
    const parts: string[] = [q(field.name), sqlType];
    // A column allows NULL when the field is explicitly nullable OR optional
    // (key may be absent). Only emit NOT NULL when the field is both required
    // and not nullable.
    const allowsNull = field.nullable === true || field.required === false;
    if (isId) {
        parts.push("PRIMARY KEY NOT NULL");
    } else if (!allowsNull) {
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
    /** The field's core type. Array stays as array. */
    type: FieldType;
    isId: boolean;
    refSchema?: string;
};

function inspectType(t: FieldType): InspectedType {
    if (t.kind === "id") return { type: t, isId: true };
    if (t.kind === "reference") {
        return { type: t, isId: false, refSchema: t.schema };
    }
    return { type: t, isId: false };
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
    }
}

function q(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
}

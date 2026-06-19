import path from "node:path";
import type { IRSchema, IRField, IRType } from "@keyma/ir";
import { exprToPython } from "./emit-expression.js";
import { irTypeToPython } from "./ir-type-to-python.js";
import { buildSchemaData, buildMaterializer, hasComputedFields } from "./schema-data.js";

type ModelEmitOptions = {
    includePrivate: boolean;
    includeIndexes: boolean;
    emitMaterializers: boolean;
    formPhasesOnly: boolean;
    schemaPaths: ReadonlyMap<string, string>;
};

export function emitModelPython(schema: IRSchema, opts: ModelEmitOptions): string {
    const fields = visibleFields(schema, opts.includePrivate);
    const refs = schemaRefImports(fields, opts.schemaPaths);
    const lines: string[] = [];

    lines.push("from __future__ import annotations");
    lines.push("from typing import Any, List, Optional, Literal, Dict");
    lines.push("from datetime import datetime");
    lines.push("import re");
    lines.push("");

    const currentPath = opts.schemaPaths.get(schema.sourceName)!;

    // Import parent class for inheritance.
    if (schema.extends !== undefined) {
        const parentPath = opts.schemaPaths.get(schema.extends);
        if (parentPath !== undefined) {
            const rel = pythonRelImport(currentPath, parentPath);
            lines.push(`from ${rel} import ${schema.extends}`);
        }
    }

    // Import embedded and reference types.
    for (const ref of refs) {
        if (ref.className === schema.sourceName) continue;
        const rel = pythonRelImport(currentPath, ref.fileName);
        lines.push(`from ${rel} import ${ref.className}`);
    }

    lines.push("");
    lines.push("");

    const extendsClause = schema.extends !== undefined ? `(${schema.extends})` : "";
    lines.push(`class ${schema.sourceName}${extendsClause}:`);
    
    // Class-level schema metadata
    const schemaData = buildSchemaData(schema, {
        includePrivate: opts.includePrivate,
        includeIndexes: opts.includeIndexes,
        formPhasesOnly: opts.formPhasesOnly,
    });
    
    // We'll attach the schema at the end of the file or inside the class.
    // In Python, it's common to put it in a class attribute.
    
    lines.push(`    def __init__(self, value: Dict[str, Any] = None):`);
    if (schema.extends !== undefined) {
        lines.push(`        super().__init__(value)`);
    }
    lines.push(`        if value:`);
    let assigned = false;
    for (const field of fields) {
        if (field.computed !== undefined) continue;
        lines.push(`            self.${field.name}: ${irTypeToPython(field.type)} = value.get("${field.name}")`);
        assigned = true;
    }
    if (!assigned && schema.extends === undefined) {
        lines.push(`            pass`);
    } else if (!assigned) {
        // super already called
    }

    // Computed getters (properties).
    for (const field of fields) {
        if (field.computed === undefined) continue;
        lines.push("");
        lines.push(`    @property`);
        lines.push(`    def ${field.name}(self) -> ${irTypeToPython(field.type)}:`);
        lines.push(`        return ${exprToPython(field.computed.expression)}`);
    }

    lines.push("");
    
    // Schema metadata
    const schemaLiteral = formatPythonLiteral(schemaData, refs);
    lines.push(`${schema.sourceName}.schema = ${schemaLiteral}`);

    // Materializer.
    if (opts.emitMaterializers) {
        const materializer = buildMaterializer(schema, opts.includePrivate);
        if (materializer !== null) {
            lines.push("");
            lines.push(materializer);
        }
    }

    lines.push("");
    return lines.join("\n");
}

function visibleFields(schema: IRSchema, includePrivate: boolean): IRField[] {
    return includePrivate ? schema.fields : schema.fields.filter((f) => f.visibility === "public");
}

type SchemaRefImport = { className: string; fileName: string };

function schemaRefImports(fields: IRField[], fileNames: ReadonlyMap<string, string>): SchemaRefImport[] {
    const seen = new Set<string>();
    const result: SchemaRefImport[] = [];
    const collect = (type: IRType): void => {
        if (type.kind === "embedded" || type.kind === "reference") {
            if (!seen.has(type.schema)) {
                const fileName = fileNames.get(type.schema);
                if (fileName !== undefined) {
                    seen.add(type.schema);
                    result.push({ className: type.schema, fileName });
                }
            }
        } else if (type.kind === "nullable" || type.kind === "array") {
            collect(type.of);
        }
    };
    for (const field of fields) {
        collect(field.type);
    }
    return result;
}

function formatPythonLiteral(data: any, refs: SchemaRefImport[]): string {
    // Basic JSON to Python literal conversion
    let s = JSON.stringify(data, null, 4);
    s = s.replace(/: true/g, ": True");
    s = s.replace(/: false/g, ": False");
    s = s.replace(/: null/g, ": None");
    
    // Handle refs Map equivalent in Python (dict)
    if (refs.length > 0) {
        const entries = refs.map((r) => `"${r.className}": ${r.className}`).join(", ");
        const refsDict = `{${entries}}`;
        // Inject refs into the literal
        // This is a bit hacky with JSON.stringify, better build it manually if complex.
        const lines = s.split("\n");
        const insertAt = lines.length - 2;
        lines[insertAt] += ",";
        lines.splice(insertAt + 1, 0, `    "refs": ${refsDict},`);
        return lines.join("\n");
    }
    
    return s;
}

function pythonRelImport(from: string, to: string): string {
    const fromDir = path.posix.dirname(from);
    let rel = path.posix.relative(fromDir, to);
    
    // Python relative imports:
    // same dir: .other
    // sub dir: .sub.other
    // parent dir: ..other
    
    const parts = rel.split("/");
    let dots = ".";
    while (parts[0] === "..") {
        dots += ".";
        parts.shift();
    }
    
    if (parts.length === 1 && parts[0] === ".") {
        // same file? shouldn't happen
        return ".";
    }
    
    const modPath = parts.join(".");
    // Remove .py extension if present
    const cleanModPath = modPath.endsWith(".py") ? modPath.slice(0, -3) : modPath;
    
    return dots + cleanModPath;
}

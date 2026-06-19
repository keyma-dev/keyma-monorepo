import path from "node:path";
import type { IRSchema, IRField, IRType, IRMethod } from "@keyma/ir";
import { exprToPython } from "./emit-expression.js";
import { stmtToPython } from "./emit-validators.js";
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
        lines.push(`            self.${field.name}: ${fieldAnnotation(field)} = value.get("${field.name}")`);
        assigned = true;
    }
    if (!assigned && schema.extends === undefined) {
        lines.push(`            pass`);
    } else if (!assigned) {
        // super already called
    }

    // Computed getters (properties).
    const computedNames = new Set<string>();
    for (const field of fields) {
        if (field.computed === undefined) continue;
        computedNames.add(field.name);
        lines.push("");
        lines.push(`    @property`);
        lines.push(`    def ${field.name}(self) -> ${fieldAnnotation(field)}:`);
        lines.push(`        return ${exprToPython(field.computed.expression)}`);
    }

    // Methods and setters (portable behaviors). `self.<field>` reads/writes fields.
    for (const method of visibleMethods(schema, opts.includePrivate)) {
        lines.push("");
        lines.push(...emitMethodPython(method, computedNames));
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

function visibleMethods(schema: IRSchema, includePrivate: boolean): IRMethod[] {
    const methods = schema.methods ?? [];
    return includePrivate ? methods : methods.filter((m) => m.visibility === "public");
}

/**
 * Emit a method or setter as Python class members. Methods become plain `def`s.
 * A setter pairs with a same-named `@property` (a computed getter) via the
 * `@<name>.setter` decorator when one exists; otherwise it is wired through a
 * setter-only `property(None, ...)` so writes still dispatch to the body.
 */
function emitMethodPython(method: IRMethod, computedNames: ReadonlySet<string>): string[] {
    const lines: string[] = [];
    const body = methodBodyPython(method);

    if (method.kind === "setter") {
        const valueParam = method.params[0]?.name ?? "value";
        if (computedNames.has(method.name)) {
            lines.push(`    @${method.name}.setter`);
            lines.push(`    def ${method.name}(self, ${valueParam}):`);
            lines.push(...body);
        } else {
            const helper = `_set_${method.name}`;
            lines.push(`    def ${helper}(self, ${valueParam}):`);
            lines.push(...body);
            lines.push(`    ${method.name} = property(None, ${helper})`);
        }
        return lines;
    }

    const params = ["self", ...method.params.map((p) => p.name)].join(", ");
    lines.push(`    def ${method.name}(${params}):`);
    lines.push(...body);
    return lines;
}

/** Render a behavior body (8-space indented), or `pass` when empty. */
function methodBodyPython(method: IRMethod): string[] {
    if (method.statements.length === 0) return ["        pass"];
    return method.statements.map((s) => stmtToPython(s, "        "));
}

/**
 * Render a field's Python type annotation. The core type comes from the type
 * mapper; nullability is a field-level axis (`field.nullable`) so we wrap in
 * `Optional[...]` here. Optionality (`!field.required`, i.e. key may be absent)
 * also surfaces as `None` in Python — there is no separate `undefined` — so an
 * optional field is likewise wrapped in `Optional[...]`.
 */
function fieldAnnotation(field: IRField): string {
    const core = irTypeToPython(field.type);
    if (field.nullable || !field.required) {
        return core.startsWith("Optional[") ? core : `Optional[${core}]`;
    }
    return core;
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
        } else if (type.kind === "array") {
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

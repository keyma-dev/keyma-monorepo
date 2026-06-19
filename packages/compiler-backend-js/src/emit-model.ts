import path from "node:path";
import type { IRSchema, IRField, IRType, IRMethod } from "@keyma/ir";
import { exprToJs, stmtToJs } from "./emit-expression.js";
import { irTypeToTs } from "./ir-type-to-ts.js";
import { buildSchemaData, buildMaterializer, hasComputedFields } from "./schema-data.js";

type ModelEmitOptions = {
    /** Include private fields and private computed getters. */
    includePrivate: boolean;
    /** Include index metadata (field indexes, schema indexes) in the embedded schema literal. */
    includeIndexes: boolean;
    /** Emit a `materialize<Name>` function for schemas with computed fields. */
    emitMaterializers: boolean;
    /** Client-only: restrict formatters in the embedded schema literal to form phases. */
    formPhasesOnly: boolean;
    /** Map from schema sourceName → schema file path relative to models dir (e.g. "User" → "auth/user"). */
    schemaPaths: ReadonlyMap<string, string>;
    /** Map from schema sourceName → TypeScript type name (for embedded types in .d.ts). */
    embeddedTypeNames: ReadonlyMap<string, string>;
};

const REFS_SENTINEL = "__KEYMA_REFS_PLACEHOLDER__";

/**
 * Emit a model class `.js` file for a schema. The file contains the class
 * declaration, the schema metadata frozen onto the class as a static `schema`
 * property, and (server bundles only) the materializer function.
 */
export function emitModelJs(schema: IRSchema, opts: ModelEmitOptions): string {
    const fields = visibleFields(schema, opts.includePrivate);
    const refs = schemaRefImports(fields, opts.schemaPaths);
    const lines: string[] = [];

    const currentPath = opts.schemaPaths.get(schema.sourceName)!;

    // Import embedded and reference types (needed for refs and embedded constructors).
    // A self-reference (e.g. `Reference<User>` inside User) resolves to the class
    // declared in this very file — importing it would shadow that declaration.
    for (const ref of refs) {
        if (ref.className === schema.sourceName) continue;
        const importPath = relImport(currentPath, ref.fileName);
        if (!lines.some((l) => l.includes(`"${importPath}"`))) {
            lines.push(`import { ${ref.className} } from "${importPath}";`);
        }
    }

    if (lines.length > 0) lines.push("");

    // Inheritance is fully flattened in the IR — emit a flat class with every
    // (inherited + own) field assigned exactly once. No `extends`/`super`.
    lines.push(`export class ${schema.sourceName} {`);
    lines.push(`    constructor(value) {`);
    lines.push(`        if (value) {`);
    for (const field of fields) {
        if (field.computed !== undefined) continue;
        lines.push(`            this.${field.name} = value.${field.name};`);
    }
    lines.push(`        }`);
    lines.push(`    }`);

    // Computed getters.
    for (const field of fields) {
        if (field.computed === undefined) continue;
        lines.push("");
        lines.push(`    get ${field.name}() {`);
        lines.push(`        return ${exprToJs(field.computed.expression)};`);
        lines.push(`    }`);
    }

    // Methods and setters (portable behaviors). `this.<field>` reads/writes the
    // record's fields; `stmtToJs`'s default field-access renders `this.<name>`.
    for (const method of visibleMethods(schema, opts.includePrivate)) {
        lines.push("");
        const params = method.params.map((p) => p.name).join(", ");
        const signature = method.kind === "setter"
            ? `    set ${method.name}(${params}) {`
            : `    ${method.name}(${params}) {`;
        lines.push(signature);
        for (const stmt of method.statements) {
            lines.push(stmtToJs(stmt, "        "));
        }
        lines.push(`    }`);
    }

    lines.push(`}`);
    lines.push("");

    // Attach schema metadata as a frozen object on the class.
    const schemaData = buildSchemaData(schema, {
        includePrivate: opts.includePrivate,
        includeIndexes: opts.includeIndexes,
        formPhasesOnly: opts.formPhasesOnly,
    });
    const literal = formatSchemaLiteral(schemaData, refs);
    lines.push(`${schema.sourceName}.schema = Object.freeze(${literal});`);

    // Materializer (server bundles only).
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

/**
 * Emit a model class `.d.ts` declaration file for a schema.
 */
export function emitModelDts(schema: IRSchema, opts: ModelEmitOptions): string {
    const fields = visibleFields(schema, opts.includePrivate);
    const lines: string[] = [];

    const currentPath = opts.schemaPaths.get(schema.sourceName)!;

    lines.push(`import type { SchemaMetadata } from "@keyma/runtime-js";`);

    // Edge schemas need EdgeBrand for type-level traversal narrowing.
    if (schema.edge !== undefined) {
        lines.push(`import type { EdgeBrand } from "@keyma/dsl";`);
    }

    // Import embedded and reference types. Skip a self-reference — the class is
    // already declared in this file (see the .js emitter for the same guard).
    for (const ref of schemaRefImports(fields, opts.schemaPaths)) {
        if (ref.className === schema.sourceName) continue;
        const importPath = relImport(currentPath, ref.fileName);
        if (!lines.some((l) => l.includes(`"${importPath}"`))) {
            lines.push(`import type { ${ref.className} } from "${importPath}";`);
        }
    }

    // Edges need instance types of from/to even if those aren't already imported
    // via field references — though in practice they always are (the from/to fields
    // are Reference<...> typed). Belt-and-suspenders:
    if (schema.edge !== undefined) {
        for (const className of [schema.edge.from, schema.edge.to]) {
            const targetPath = opts.schemaPaths.get(className);
            if (targetPath !== undefined) {
                const importPath = relImport(currentPath, targetPath);
                if (!lines.some((l) => l.includes(`"${importPath}"`))) {
                    lines.push(`import type { ${className} } from "${importPath}";`);
                }
            }
        }
    }

    lines.push("");

    // Edge schemas use the const + type pattern so the constructor value carries
    // EdgeBrand<From, To>. Non-edge schemas use the conventional `export declare class`.
    const isEdge = schema.edge !== undefined;
    const className = schema.sourceName;
    const declName = isEdge ? `_${className}` : className;
    const declKeyword = isEdge ? "declare class" : "export declare class";

    // Flat class — inheritance is flattened into the field list upstream.
    lines.push(`${declKeyword} ${declName} {`);
    lines.push(`    static readonly schema: SchemaMetadata;`);

    // Regular fields. `| null` is the nullability axis; `| undefined` is the
    // optionality (key-absent) axis — they compose independently.
    for (const field of fields) {
        if (field.computed !== undefined) continue;
        const nul = field.nullable ? " | null" : "";
        const optional = !field.required ? " | undefined" : "";
        const ro = field.readonly ? "readonly " : "";
        for (const jsdoc of fieldJsDoc(field)) lines.push(jsdoc);
        lines.push(`    ${ro}${field.name}: ${irTypeToTs(field.type, opts.embeddedTypeNames)}${nul}${optional};`);
    }

    // Computed getters.
    for (const field of fields) {
        if (field.computed === undefined) continue;
        const nul = field.nullable ? " | null" : "";
        const tsType = irTypeToTs(field.type, opts.embeddedTypeNames);
        for (const jsdoc of fieldJsDoc(field)) lines.push(jsdoc);
        lines.push(`    get ${field.name}(): ${tsType}${nul};`);
    }

    // Methods and setters (portable behaviors).
    for (const method of visibleMethods(schema, opts.includePrivate)) {
        const params = method.params
            .map((p) => `${p.name}: ${irTypeToTs(p.type, opts.embeddedTypeNames)}`)
            .join(", ");
        if (method.kind === "setter") {
            lines.push(`    set ${method.name}(${params});`);
        } else {
            const ret = method.returnType ? irTypeToTs(method.returnType, opts.embeddedTypeNames) : "void";
            lines.push(`    ${method.name}(${params}): ${ret};`);
        }
    }

    // Constructor.
    const ctorFields = fields.filter((f) => f.computed === undefined);
    const ctorParams = ctorFields
        .map((f) => `${f.name}?: ${irTypeToTs(f.type, opts.embeddedTypeNames)}${f.nullable ? " | null" : ""}`)
        .join("; ");
    lines.push(`    constructor(value?: { ${ctorParams} });`);
    lines.push(`}`);

    if (isEdge && schema.edge !== undefined) {
        // The const carries the EdgeBrand on `typeof _Class`; the type alias
        // exposes the instance type under the public name.
        lines.push("");
        lines.push(
            `export declare const ${className}: typeof ${declName} & EdgeBrand<${schema.edge.from}, ${schema.edge.to}>;`,
        );
        lines.push(`export type ${className} = InstanceType<typeof ${declName}>;`);
    }

    // Materializer declaration (server bundles only).
    if (opts.emitMaterializers && hasComputedFields(schema, opts.includePrivate)) {
        lines.push("");
        lines.push(`export declare function materialize${schema.sourceName}(value: Record<string, unknown>): Record<string, unknown>;`);
    }

    lines.push("");
    return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function visibleFields(schema: IRSchema, includePrivate: boolean): IRField[] {
    return includePrivate ? schema.fields : schema.fields.filter((f) => f.visibility === "public");
}

function visibleMethods(schema: IRSchema, includePrivate: boolean): IRMethod[] {
    const methods = schema.methods ?? [];
    return includePrivate ? methods : methods.filter((m) => m.visibility === "public");
}

/** Build JSDoc lines for a field from its `@FormField`/`@Deprecated` metadata. */
function fieldJsDoc(field: IRField): string[] {
    const body: string[] = [];
    if (field.form?.title) body.push(field.form.title);
    if (field.form?.hint) body.push(field.form.hint);
    if (field.deprecated !== undefined) {
        body.push(typeof field.deprecated === "string" ? `@deprecated ${field.deprecated}` : "@deprecated");
    }
    if (body.length === 0) return [];
    if (body.length === 1) return [`    /** ${body[0]} */`];
    return ["    /**", ...body.map((l) => `     * ${l}`), "     */"];
}

type SchemaRefImport = { className: string; fileName: string };

/** Collect all embedded and reference schema names referenced in a field list. */
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

/**
 * Render the schema metadata as a JS object literal, splicing in a `refs`
 * property whose values are bare class identifiers (not JSON-encodable).
 */
function formatSchemaLiteral(schemaData: object, refs: SchemaRefImport[]): string {
    if (refs.length === 0) {
        return JSON.stringify(schemaData, null, 4);
    }
    const withSentinel = { ...schemaData, refs: REFS_SENTINEL };
    const json = JSON.stringify(withSentinel, null, 4);
    const entries = refs.map((r) => `[${JSON.stringify(r.className)}, ${r.className}]`).join(", ");
    const refsExpr = `new Map([${entries}])`;
    return json.replace(`"${REFS_SENTINEL}"`, refsExpr);
}

function relImport(from: string, to: string): string {
    let rel = path.posix.relative(path.posix.dirname(from), to);
    if (!rel.startsWith(".")) rel = "./" + rel;
    return rel + ".js";
}

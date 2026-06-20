import type {
    IRSchema, IRField, IRType, IRMethod, IRExpression, IRStatement,
    IRValidatorDeclaration, IRFormatterDeclaration,
} from "@keyma/ir";
import { exprToJs, stmtToJs } from "./emit-expression.js";
import { irTypeToTs } from "./ir-type-to-ts.js";
import { buildSchemaData, buildMaterializer, hasComputedFields } from "./schema-data.js";
import { emitLiteral } from "./emit-literal.js";
import { factoryIdent } from "./emit-validators.js";
import { relModuleSpecifier } from "./module-path.js";

export type ModuleEmitDeps = {
    /** Include private fields and private computed getters. */
    includePrivate: boolean;
    /** Include index metadata in the embedded schema literal. */
    includeIndexes: boolean;
    /** Emit `materialize<Name>` for schemas with computed fields. */
    emitMaterializers: boolean;
    /** Client-only: restrict formatters in the embedded schema literal to form phases. */
    formPhasesOnly: boolean;
    /** Include the per-schema `applyDefaults` arrow (server/library bundles). */
    includeDefaults: boolean;
    /** sourceName → bundle-relative module ref (e.g. "models/user/user"). */
    schemaModule: ReadonlyMap<string, string>;
    /** sourceName → TypeScript type name (for embedded types in .d.ts). */
    embeddedTypeNames: ReadonlyMap<string, string>;
    /** Validator/formatter declarations keyed by name (for factory-call arg ordering). */
    validatorDecls: ReadonlyMap<string, IRValidatorDeclaration>;
    formatterDecls: ReadonlyMap<string, IRFormatterDeclaration>;
    /** Known utility-function names (for import collection from the functions module). */
    functionNames: ReadonlySet<string>;
    /** Bundle-relative refs for the shared factory modules. */
    validatorsModuleRef: string;
    formattersModuleRef: string;
    functionsModuleRef: string;
};

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

// ─── JS module ─────────────────────────────────────────────────────────────────

/** Emit one model module `.js` containing every schema authored in a source file. */
export function emitModuleJs(moduleRef: string, schemas: readonly IRSchema[], deps: ModuleEmitDeps): string {
    const importLines = buildImports(moduleRef, schemas, deps, false);
    const bodies = schemas.map((s) => emitSchemaClassJs(s, deps));
    return [...importLines, ...(importLines.length > 0 ? [""] : []), bodies.join("\n")].join("\n");
}

function emitSchemaClassJs(schema: IRSchema, deps: ModuleEmitDeps): string {
    const fields = visibleFields(schema, deps.includePrivate);
    const lines: string[] = [];

    // Inheritance is fully flattened in the IR — a flat class, every field assigned once.
    lines.push(`export class ${schema.sourceName} {`);
    lines.push(`    constructor(value) {`);
    lines.push(`        if (value) {`);
    for (const field of fields) {
        if (field.computed !== undefined) continue;
        lines.push(`            this.${field.name} = value.${field.name};`);
    }
    lines.push(`        }`);
    lines.push(`    }`);

    for (const field of fields) {
        if (field.computed === undefined) continue;
        lines.push("");
        lines.push(`    get ${field.name}() {`);
        lines.push(`        return ${exprToJs(field.computed.expression)};`);
        lines.push(`    }`);
    }

    for (const method of visibleMethods(schema, deps.includePrivate)) {
        lines.push("");
        const params = method.params.map((p) => p.name).join(", ");
        const signature = method.kind === "setter"
            ? `    set ${method.name}(${params}) {`
            : `    ${method.name}(${params}) {`;
        lines.push(signature);
        for (const stmt of method.statements) lines.push(stmtToJs(stmt, "        "));
        lines.push(`    }`);
    }

    lines.push(`}`);
    lines.push("");

    const refs = schemaRefClassNames(fields, deps.schemaModule);
    const schemaData = buildSchemaData(schema, {
        includePrivate: deps.includePrivate,
        includeIndexes: deps.includeIndexes,
        formPhasesOnly: deps.formPhasesOnly,
        includeDefaults: deps.includeDefaults,
        validatorDecls: deps.validatorDecls,
        formatterDecls: deps.formatterDecls,
        refs,
    });
    lines.push(`${schema.sourceName}.schema = Object.freeze(${emitLiteral(schemaData)});`);

    if (deps.emitMaterializers) {
        const materializer = buildMaterializer(schema, deps.includePrivate);
        if (materializer !== null) {
            lines.push("");
            lines.push(materializer);
        }
    }

    lines.push("");
    return lines.join("\n");
}

// ─── .d.ts module ──────────────────────────────────────────────────────────────

/** Emit one model module `.d.ts` declaring every schema authored in a source file. */
export function emitModuleDts(moduleRef: string, schemas: readonly IRSchema[], deps: ModuleEmitDeps): string {
    const lines: string[] = [];
    lines.push(`import type { SchemaMetadata } from "@keyma/runtime-js";`);
    if (schemas.some((s) => s.edge !== undefined)) {
        lines.push(`import type { EdgeBrand } from "@keyma/dsl";`);
    }
    lines.push(...buildImports(moduleRef, schemas, deps, true));
    lines.push("");

    for (const schema of schemas) lines.push(emitSchemaClassDts(schema, deps));

    return lines.join("\n");
}

function emitSchemaClassDts(schema: IRSchema, deps: ModuleEmitDeps): string {
    const fields = visibleFields(schema, deps.includePrivate);
    const lines: string[] = [];

    const isEdge = schema.edge !== undefined;
    const className = schema.sourceName;
    const declName = isEdge ? `_${className}` : className;
    const declKeyword = isEdge ? "declare class" : "export declare class";

    lines.push(`${declKeyword} ${declName} {`);
    lines.push(`    static readonly schema: SchemaMetadata;`);

    for (const field of fields) {
        if (field.computed !== undefined) continue;
        const nul = field.nullable ? " | null" : "";
        const optional = !field.required ? " | undefined" : "";
        const ro = field.readonly ? "readonly " : "";
        for (const jsdoc of fieldJsDoc(field)) lines.push(jsdoc);
        lines.push(`    ${ro}${field.name}: ${irTypeToTs(field.type, deps.embeddedTypeNames)}${nul}${optional};`);
    }

    for (const field of fields) {
        if (field.computed === undefined) continue;
        const nul = field.nullable ? " | null" : "";
        const tsType = irTypeToTs(field.type, deps.embeddedTypeNames);
        for (const jsdoc of fieldJsDoc(field)) lines.push(jsdoc);
        lines.push(`    get ${field.name}(): ${tsType}${nul};`);
    }

    for (const method of visibleMethods(schema, deps.includePrivate)) {
        const params = method.params
            .map((p) => `${p.name}: ${irTypeToTs(p.type, deps.embeddedTypeNames)}`)
            .join(", ");
        if (method.kind === "setter") {
            lines.push(`    set ${method.name}(${params});`);
        } else {
            const ret = method.returnType ? irTypeToTs(method.returnType, deps.embeddedTypeNames) : "void";
            lines.push(`    ${method.name}(${params}): ${ret};`);
        }
    }

    const ctorFields = fields.filter((f) => f.computed === undefined);
    const ctorParams = ctorFields
        .map((f) => `${f.name}?: ${irTypeToTs(f.type, deps.embeddedTypeNames)}${f.nullable ? " | null" : ""}`)
        .join("; ");
    lines.push(`    constructor(value?: { ${ctorParams} });`);
    lines.push(`}`);

    if (isEdge && schema.edge !== undefined) {
        lines.push("");
        lines.push(
            `export declare const ${className}: typeof ${declName} & EdgeBrand<${schema.edge.from}, ${schema.edge.to}>;`,
        );
        lines.push(`export type ${className} = InstanceType<typeof ${declName}>;`);
    }

    if (deps.emitMaterializers && hasComputedFields(schema, deps.includePrivate)) {
        lines.push("");
        lines.push(`export declare function materialize${schema.sourceName}(value: Record<string, unknown>): Record<string, unknown>;`);
    }

    lines.push("");
    return lines.join("\n");
}

// ─── Import resolution ─────────────────────────────────────────────────────────

/**
 * Build the import lines a module needs: cross-module schema/embedded refs, the
 * validator/formatter factories referenced by its fields, and any utility functions
 * referenced by its computed/materializer/method/default bodies. Same-module refs
 * are skipped (the binding is declared in this very file).
 */
function buildImports(moduleRef: string, schemas: readonly IRSchema[], deps: ModuleEmitDeps, typeOnly: boolean): string[] {
    const bySpec = new Map<string, Set<string>>();
    const add = (spec: string, binding: string): void => {
        if (!bySpec.has(spec)) bySpec.set(spec, new Set());
        bySpec.get(spec)!.add(binding);
    };

    const allFields: IRField[] = schemas.flatMap((s) => visibleFields(s, deps.includePrivate));

    // Cross-module schema/embedded class refs.
    for (const target of collectRefTargets(allFields)) {
        const targetRef = deps.schemaModule.get(target);
        if (targetRef === undefined || targetRef === moduleRef) continue;
        add(relModuleSpecifier(moduleRef, targetRef), target);
    }
    // Edges also need from/to node instance types in .d.ts.
    if (typeOnly) {
        for (const s of schemas) {
            if (s.edge === undefined) continue;
            for (const node of [s.edge.from, s.edge.to]) {
                const targetRef = deps.schemaModule.get(node);
                if (targetRef === undefined || targetRef === moduleRef) continue;
                add(relModuleSpecifier(moduleRef, targetRef), node);
            }
        }
    }

    if (!typeOnly) {
        // Validator/formatter factories referenced by the fields.
        const validators = collectFactoryNames(allFields, "validators", deps.formPhasesOnly);
        const formatters = collectFactoryNames(allFields, "formatters", deps.formPhasesOnly);
        for (const n of validators) add(relModuleSpecifier(moduleRef, deps.validatorsModuleRef), factoryIdent(n));
        for (const n of formatters) add(relModuleSpecifier(moduleRef, deps.formattersModuleRef), factoryIdent(n));

        // Utility functions referenced by emitted bodies.
        for (const n of collectFunctionRefs(schemas, deps)) {
            add(relModuleSpecifier(moduleRef, deps.functionsModuleRef), n);
        }
    }

    const kw = typeOnly ? "import type" : "import";
    return [...bySpec.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([spec, bindings]) => `${kw} { ${[...bindings].sort().join(", ")} } from "${spec}";`);
}

/** Embedded/reference class names referenced by a field list (for the `refs` Map). */
function schemaRefClassNames(fields: IRField[], schemaModule: ReadonlyMap<string, string>): string[] {
    return [...collectRefTargets(fields)].filter((t) => schemaModule.has(t));
}

function collectRefTargets(fields: IRField[]): Set<string> {
    const out = new Set<string>();
    const collect = (type: IRType): void => {
        if (type.kind === "embedded" || type.kind === "reference") out.add(type.schema);
        else if (type.kind === "array") collect(type.of);
    };
    for (const f of fields) collect(f.type);
    return out;
}

function collectFactoryNames(fields: IRField[], which: "validators" | "formatters", formPhasesOnly: boolean): Set<string> {
    const out = new Set<string>();
    for (const f of fields) {
        if (which === "validators") {
            for (const v of f.validators) out.add(v.name);
        } else {
            for (const fmt of f.formatters) {
                if (formPhasesOnly && !CLIENT_PHASES.has(fmt.phase)) continue;
                out.add(fmt.spec.name);
            }
        }
    }
    return out;
}

/** Utility-function names referenced by a module's computed/materializer/method/default bodies. */
function collectFunctionRefs(schemas: readonly IRSchema[], deps: ModuleEmitDeps): Set<string> {
    const ids = new Set<string>();
    for (const schema of schemas) {
        for (const field of visibleFields(schema, deps.includePrivate)) {
            if (field.computed !== undefined) collectIdentifiers(field.computed.expression, ids);
            if (deps.includeDefaults && field.default !== undefined && field.default.kind === "expression") {
                collectIdentifiers(field.default.expression, ids);
            }
        }
        for (const method of visibleMethods(schema, deps.includePrivate)) {
            for (const stmt of method.statements) collectStatementIdentifiers(stmt, ids);
        }
    }
    return new Set([...ids].filter((id) => deps.functionNames.has(id)));
}

function collectIdentifiers(expr: IRExpression, out: Set<string>): void {
    switch (expr.kind) {
        case "identifier": out.add(expr.name); break;
        case "member": collectIdentifiers(expr.object, out); break;
        case "call": collectIdentifiers(expr.callee, out); expr.args.forEach((a) => collectIdentifiers(a, out)); break;
        case "new": collectIdentifiers(expr.callee, out); expr.args.forEach((a) => collectIdentifiers(a, out)); break;
        case "typeof": collectIdentifiers(expr.operand, out); break;
        case "unary": collectIdentifiers(expr.operand, out); break;
        case "template": expr.parts.forEach((p) => collectIdentifiers(p, out)); break;
        case "binary": collectIdentifiers(expr.left, out); collectIdentifiers(expr.right, out); break;
        case "conditional":
            collectIdentifiers(expr.condition, out);
            collectIdentifiers(expr.whenTrue, out);
            collectIdentifiers(expr.whenFalse, out);
            break;
        case "object": expr.properties.forEach((p) => collectIdentifiers(p.value, out)); break;
        case "arrow": collectIdentifiers(expr.body, out); break;
        case "intrinsic":
            if (expr.receiver) collectIdentifiers(expr.receiver, out);
            expr.args.forEach((a) => collectIdentifiers(a, out));
            break;
    }
}

function collectStatementIdentifiers(stmt: IRStatement, out: Set<string>): void {
    switch (stmt.kind) {
        case "return": if (stmt.value) collectIdentifiers(stmt.value, out); break;
        case "expression": collectIdentifiers(stmt.expr, out); break;
        case "const": collectIdentifiers(stmt.init, out); break;
        case "assign": collectIdentifiers(stmt.target, out); collectIdentifiers(stmt.value, out); break;
        case "if":
            collectIdentifiers(stmt.condition, out);
            stmt.consequent.forEach((s) => collectStatementIdentifiers(s, out));
            (stmt.alternate ?? []).forEach((s) => collectStatementIdentifiers(s, out));
            break;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function visibleFields(schema: IRSchema, includePrivate: boolean): IRField[] {
    return includePrivate ? schema.fields : schema.fields.filter((f) => f.visibility === "public");
}

function visibleMethods(schema: IRSchema, includePrivate: boolean): IRMethod[] {
    const methods = schema.methods ?? [];
    return includePrivate ? methods : methods.filter((m) => m.visibility === "public");
}

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

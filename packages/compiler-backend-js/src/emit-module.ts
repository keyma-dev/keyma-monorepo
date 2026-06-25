import type {
    IRSchema, IRField,
    IRValidatorDeclaration, IRFormatterDeclaration,
} from "@keyma/ir";
import { collectRefTargets, collectFunctionRefs, filterVisibleFields, filterVisibleMethods } from "@keyma/compiler-util";
import { stmtToJs } from "./emit-expression.js";
import { irTypeToTs } from "./ir-type-to-ts.js";
import { buildSchemaData } from "./schema-data.js";
import { emitLiteral } from "./emit-literal.js";
import { factoryIdent } from "./emit-validators.js";
import { relModuleSpecifier } from "./module-path.js";
import { TYPES_REF } from "./emit-types.js";

export type ModuleEmitDeps = {
    /** Include private fields and private computed getters. */
    includePrivate: boolean;
    /** Include index metadata in the embedded schema literal. */
    includeIndexes: boolean;
    /** Client-only: restrict formatters in the embedded schema literal to form phases. */
    formPhasesOnly: boolean;
    /** Include the per-schema `applyDefaults` arrow (server/library bundles). */
    includeDefaults: boolean;
    /** sourceName → bundle-relative module ref (e.g. "models/user/user"). */
    schemaModule: ReadonlyMap<string, string>;
    /** Reference/embedded/edge target `name` → emitted class symbol (`sourceName`).
     *  Resolves a target's identity to the TS type / class binding to import. */
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
    const fields = filterVisibleFields(schema, deps.includePrivate);
    const lines: string[] = [];

    // Inheritance is fully flattened in the IR — a flat class, every field assigned once.
    lines.push(`export class ${schema.sourceName} {`);
    lines.push(`    constructor(value) {`);
    lines.push(`        if (value) {`);
    for (const field of fields) {
        lines.push(`            this.${field.name} = value.${field.name};`);
    }
    lines.push(`        }`);
    lines.push(`    }`);

    // Getters, setters, and methods are all behaviors re-emitted as class members.
    for (const method of filterVisibleMethods(schema, deps.includePrivate)) {
        lines.push("");
        const params = method.params.map((p) => p.name).join(", ");
        const signature =
            method.kind === "setter" ? `    set ${method.name}(${params}) {`
            : method.kind === "getter" ? `    get ${method.name}() {`
            : `    ${method.name}(${params}) {`;
        lines.push(signature);
        for (const stmt of method.statements) lines.push(stmtToJs(stmt, "        "));
        lines.push(`    }`);
    }

    lines.push(`}`);
    lines.push("");

    const refs = schemaRefs(fields, deps.embeddedTypeNames);
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

    lines.push("");
    return lines.join("\n");
}

// ─── .d.ts module ──────────────────────────────────────────────────────────────

/** Emit one model module `.d.ts` declaring every schema authored in a source file. */
export function emitModuleDts(moduleRef: string, schemas: readonly IRSchema[], deps: ModuleEmitDeps): string {
    const lines: string[] = [];
    lines.push(`import type { SchemaMetadata } from "${relModuleSpecifier(moduleRef, TYPES_REF)}";`);
    lines.push(...buildImports(moduleRef, schemas, deps, true));
    lines.push("");

    for (const schema of schemas) lines.push(emitSchemaClassDts(schema, deps));

    return lines.join("\n");
}

function emitSchemaClassDts(schema: IRSchema, deps: ModuleEmitDeps): string {
    const fields = filterVisibleFields(schema, deps.includePrivate);
    const lines: string[] = [];

    const isEdge = schema.edge !== undefined;
    const className = schema.sourceName;
    const declName = isEdge ? `_${className}` : className;
    const declKeyword = isEdge ? "declare class" : "export declare class";

    lines.push(`${declKeyword} ${declName} {`);
    lines.push(`    static readonly schema: SchemaMetadata;`);

    for (const field of fields) {
        const nul = field.nullable ? " | null" : "";
        const optional = !field.required ? " | undefined" : "";
        const ro = field.readonly ? "readonly " : "";
        for (const jsdoc of fieldJsDoc(field)) lines.push(jsdoc);
        lines.push(`    ${ro}${field.name}: ${irTypeToTs(field.type, deps.embeddedTypeNames)}${nul}${optional};`);
    }

    for (const method of filterVisibleMethods(schema, deps.includePrivate)) {
        const params = method.params
            .map((p) => `${p.name}: ${irTypeToTs(p.type, deps.embeddedTypeNames)}`)
            .join(", ");
        if (method.kind === "setter") {
            lines.push(`    set ${method.name}(${params});`);
        } else if (method.kind === "getter") {
            const ret = method.returnType ? irTypeToTs(method.returnType, deps.embeddedTypeNames) : "void";
            lines.push(`    get ${method.name}(): ${ret};`);
        } else {
            const ret = method.returnType ? irTypeToTs(method.returnType, deps.embeddedTypeNames) : "void";
            lines.push(`    ${method.name}(${params}): ${ret};`);
        }
    }

    const ctorParams = fields
        .map((f) => `${f.name}?: ${irTypeToTs(f.type, deps.embeddedTypeNames)}${f.nullable ? " | null" : ""}`)
        .join("; ");
    lines.push(`    constructor(value?: { ${ctorParams} });`);
    lines.push(`}`);

    if (isEdge && schema.edge !== undefined) {
        // Edge endpoints are identities (`name`); the TS type is the class symbol.
        const fromTs = deps.embeddedTypeNames.get(schema.edge.from) ?? schema.edge.from;
        const toTs = deps.embeddedTypeNames.get(schema.edge.to) ?? schema.edge.to;
        lines.push("");
        lines.push(
            `export declare const ${className}: typeof ${declName} & { readonly __edge?: { from: ${fromTs}; to: ${toTs} } };`,
        );
        lines.push(`export type ${className} = InstanceType<typeof ${declName}>;`);
    }

    lines.push("");
    return lines.join("\n");
}

// ─── Import resolution ─────────────────────────────────────────────────────────

/**
 * Build the import lines a module needs: cross-module schema/embedded refs, the
 * validator/formatter factories referenced by its fields, and any utility functions
 * referenced by its getter/method/setter/default bodies. Same-module refs
 * are skipped (the binding is declared in this very file).
 */
function buildImports(moduleRef: string, schemas: readonly IRSchema[], deps: ModuleEmitDeps, typeOnly: boolean): string[] {
    const bySpec = new Map<string, Set<string>>();
    const add = (spec: string, binding: string): void => {
        if (!bySpec.has(spec)) bySpec.set(spec, new Set());
        bySpec.get(spec)!.add(binding);
    };

    const allFields: IRField[] = schemas.flatMap((s) => filterVisibleFields(s, deps.includePrivate));

    // Cross-module schema/embedded class refs. Targets are identities (`name`);
    // resolve to the emitted class symbol and its module.
    const addRef = (targetName: string): void => {
        const symbol = deps.embeddedTypeNames.get(targetName);
        if (symbol === undefined) return;
        const targetRef = deps.schemaModule.get(symbol);
        if (targetRef === undefined || targetRef === moduleRef) return;
        add(relModuleSpecifier(moduleRef, targetRef), symbol);
    };
    for (const target of collectRefTargets(allFields)) addRef(target);
    // Edges also need from/to node instance types in .d.ts.
    if (typeOnly) {
        for (const s of schemas) {
            if (s.edge === undefined) continue;
            for (const node of [s.edge.from, s.edge.to]) addRef(node);
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

/**
 * Embedded/reference targets referenced by a field list, as `{ name, symbol }`
 * pairs for the live `refs` Map — keyed by the target's `name` (the runtime
 * identity serialize/deserialize look up), valued by its emitted class symbol.
 */
function schemaRefs(
    fields: IRField[],
    embeddedTypeNames: ReadonlyMap<string, string>,
): { name: string; symbol: string }[] {
    return [...collectRefTargets(fields)]
        .filter((t) => embeddedTypeNames.has(t))
        .map((name) => ({ name, symbol: embeddedTypeNames.get(name)! }));
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

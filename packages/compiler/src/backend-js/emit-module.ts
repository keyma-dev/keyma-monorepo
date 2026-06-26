import type {
    IRClassDeclaration, IRField, IRFunctionDeclaration,
} from "@keyma/core/ir";
import {
    collectRefTargets, collectFunctionRefs, collectStatementIdentifiers,
    filterVisibleFields, filterVisibleMethods,
} from "@keyma/core/util";
import { stmtToJs } from "./emit-expression.js";
import { irTypeToTs } from "./ir-type-to-ts.js";
import type { BuildSchemaData, SchemaDtsContext, SchemaDtsShape, ClaimedFunctionRendering } from "./emitter-registry.js";
import { emitLiteral } from "./emit-literal.js";
import { factoryIdent } from "./emit-validators.js";
import { relModuleSpecifier } from "./module-path.js";
import { TYPES_REF } from "./emit-types.js";

/** The declarations a single source module owns: the schema classes authored in the file plus
 *  the (reachable) functions homed in it — plain utility helpers and claimed validator/formatter
 *  factories alike. Either list may be empty (a function-only file still produces a module). */
export type ModuleContent = {
    classes: readonly IRClassDeclaration[];
    functions: readonly IRFunctionDeclaration[];
};

export type ModuleEmitDeps = {
    /** Include private fields and private computed getters. */
    includePrivate: boolean;
    /** Include index metadata in the embedded schema literal. */
    includeIndexes: boolean;
    /** Client-only: restrict formatters in the embedded schema literal to form phases. */
    formPhasesOnly: boolean;
    /** Include the per-schema `applyDefaults` arrow (server/library bundles). */
    includeDefaults: boolean;
    /** sourceName → bundle-relative module ref (e.g. "src/user"). */
    schemaModule: ReadonlyMap<string, string>;
    /** Function name → bundle-relative module ref (e.g. "src/user", "vendor"). Covers every
     *  function the bundle keeps; cross-module function refs resolve through here. */
    functionModule: ReadonlyMap<string, string>;
    /** Reference/embedded/edge target `name` → emitted class symbol (`sourceName`).
     *  Resolves a target's identity to the TS type / class binding to import. */
    embeddedTypeNames: ReadonlyMap<string, string>;
    /** Every project-local function declaration keyed by name (a domain pack reads a
     *  validator/formatter factory's params for factory-call arg ordering). */
    functionDecls: ReadonlyMap<string, IRFunctionDeclaration>;
    /** Names of the functions rendered with the domain wrapper (validators/formatters) rather
     *  than as plain functions. The matching renderings come from `renderClaimedFunctions`. */
    claimedFunctionNames: ReadonlySet<string>;
    /** Domain-supplied builder of the per-schema `.schema` metadata object (from the
     *  emitter registry's schema pack). Threaded here so the generic module emitter
     *  stays domain-agnostic. */
    buildSchemaData: BuildSchemaData;
    /** Render the claimed (validator/formatter) functions a module owns, with the domain
     *  wrapper. Present whenever `claimedFunctionNames` is non-empty. */
    renderClaimedFunctions?: (decls: readonly IRFunctionDeclaration[]) => readonly ClaimedFunctionRendering[];
    /** Domain hook to override a schema's `.d.ts` class declaration (the schema domain uses
     *  it for edges). From the primary pack; absent for plain schema sets / core-only builds,
     *  in which case every schema emits the default `export declare class`. */
    shapeSchemaDts?: (schema: IRClassDeclaration, ctx: SchemaDtsContext) => SchemaDtsShape | undefined;
};

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

// ─── JS module ─────────────────────────────────────────────────────────────────

/** Emit one source module `.js` with every declaration authored in a source file —
 *  schema classes plus the functions homed there (plain utilities and wrapped factories). */
export function emitModuleJs(moduleRef: string, content: ModuleContent, deps: ModuleEmitDeps): string {
    const claimedByName = renderClaimed(content, deps);
    const importLines = buildImports(moduleRef, content, deps, false);
    const bodies: string[] = [];
    for (const s of content.classes) bodies.push(emitSchemaClassJs(s, deps));
    for (const fn of content.functions) {
        const rendering = claimedByName.get(fn.name);
        bodies.push(rendering !== undefined ? rendering.js : emitFunctionJs(fn));
    }
    return [...importLines, ...(importLines.length > 0 ? [""] : []), bodies.join("\n")].join("\n");
}

function emitSchemaClassJs(schema: IRClassDeclaration, deps: ModuleEmitDeps): string {
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
    const schemaData = deps.buildSchemaData(schema, {
        includePrivate: deps.includePrivate,
        includeIndexes: deps.includeIndexes,
        formPhasesOnly: deps.formPhasesOnly,
        includeDefaults: deps.includeDefaults,
        functionDecls: deps.functionDecls,
        refs,
    });
    lines.push(`${schema.sourceName}.schema = Object.freeze(${emitLiteral(schemaData)});`);

    lines.push("");
    return lines.join("\n");
}

/** Emit a plain project-local utility function as an ES-module export. */
function emitFunctionJs(decl: IRFunctionDeclaration): string {
    const params = decl.params.map((p) => p.name).join(", ");
    const body = decl.statements.map((s) => stmtToJs(s, "    ")).join("\n");
    return `export function ${decl.name}(${params}) {\n${body}\n}\n`;
}

// ─── .d.ts module ──────────────────────────────────────────────────────────────

/** Emit one source module `.d.ts` declaring every declaration authored in a source file. */
export function emitModuleDts(moduleRef: string, content: ModuleContent, deps: ModuleEmitDeps): string {
    const claimedByName = renderClaimed(content, deps);
    const lines: string[] = [];
    lines.push(...buildImports(moduleRef, content, deps, true, claimedByName));
    if (lines.length > 0) lines.push("");

    for (const schema of content.classes) lines.push(emitSchemaClassDts(schema, deps));
    for (const fn of content.functions) {
        const rendering = claimedByName.get(fn.name);
        lines.push(rendering !== undefined ? rendering.dts : emitFunctionDts(fn, deps.embeddedTypeNames));
    }

    return lines.join("\n");
}

function emitSchemaClassDts(schema: IRClassDeclaration, deps: ModuleEmitDeps): string {
    const fields = filterVisibleFields(schema, deps.includePrivate);
    const lines: string[] = [];

    // A domain may reshape the class declaration (the schema domain privatizes edge classes
    // and re-exports a branded const). Plain schemas / non-schema builds keep the default.
    const shape = deps.shapeSchemaDts?.(schema, { embeddedTypeNames: deps.embeddedTypeNames });
    const declName = shape?.declName ?? schema.sourceName;
    const declKeyword = shape?.declKeyword ?? "export declare class";

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

    if (shape?.trailer !== undefined && shape.trailer.length > 0) {
        lines.push("");
        lines.push(...shape.trailer);
    }

    lines.push("");
    return lines.join("\n");
}

/** Emit a plain project-local utility function's `.d.ts` declaration. */
function emitFunctionDts(decl: IRFunctionDeclaration, embeddedNames: ReadonlyMap<string, string>): string {
    const params = decl.params.map((p) => `${p.name}: ${irTypeToTs(p.type, embeddedNames)}`).join(", ");
    return `export declare function ${decl.name}(${params}): ${irTypeToTs(decl.returnType, embeddedNames)};\n`;
}

// ─── Import resolution ─────────────────────────────────────────────────────────

/**
 * Build the import lines a module needs: cross-module schema/embedded class refs, the
 * validator/formatter factories its fields call, the utility functions its bodies (class
 * behaviors, defaults, and the functions homed here) reference, and — in the `.d.ts` — the
 * `SchemaMetadata` type plus any wrapper types the claimed functions declare. Same-module
 * refs are skipped (the binding is declared in this very file).
 */
function buildImports(
    moduleRef: string,
    content: ModuleContent,
    deps: ModuleEmitDeps,
    typeOnly: boolean,
    claimedByName?: ReadonlyMap<string, ClaimedFunctionRendering>,
): string[] {
    const bySpec = new Map<string, Set<string>>();
    const add = (spec: string, binding: string): void => {
        if (!bySpec.has(spec)) bySpec.set(spec, new Set());
        bySpec.get(spec)!.add(binding);
    };

    const schemas = content.classes;
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
    // A domain may need extra .d.ts imports per schema (e.g. an edge's from/to node types).
    if (typeOnly && deps.shapeSchemaDts !== undefined) {
        for (const s of schemas) {
            const targets = deps.shapeSchemaDts(s, { embeddedTypeNames: deps.embeddedTypeNames })?.importTargets;
            if (targets !== undefined) for (const t of targets) addRef(t);
        }
    }

    if (!typeOnly) {
        // Functions referenced from this module — by class behaviors/defaults, by field
        // validator/formatter metadata, and by the bodies of the functions homed here.
        const fnRefs = new Set<string>();
        for (const n of collectFunctionRefs(schemas, { includePrivate: deps.includePrivate, includeDefaults: deps.includeDefaults, functionNames: new Set(deps.functionModule.keys()) })) fnRefs.add(n);
        for (const n of collectFactoryNames(allFields, "validators", deps.formPhasesOnly)) fnRefs.add(n);
        for (const n of collectFactoryNames(allFields, "formatters", deps.formPhasesOnly)) fnRefs.add(n);
        for (const fn of content.functions) {
            const ids = new Set<string>();
            for (const stmt of fn.statements) collectStatementIdentifiers(stmt, ids);
            for (const id of ids) if (deps.functionModule.has(id)) fnRefs.add(id);
        }
        for (const n of fnRefs) {
            const targetRef = deps.functionModule.get(n);
            if (targetRef === undefined || targetRef === moduleRef) continue;
            add(relModuleSpecifier(moduleRef, targetRef), factoryIdent(n));
        }
    } else {
        // The `.d.ts` imports `SchemaMetadata` (when classes are present) and any wrapper
        // types the claimed functions declare (e.g. `ValidatorFn` from the types module).
        const typeNames = new Set<string>();
        if (schemas.length > 0) typeNames.add("SchemaMetadata");
        if (claimedByName !== undefined) {
            for (const fn of content.functions) {
                for (const t of claimedByName.get(fn.name)?.dtsTypeImports ?? []) typeNames.add(t);
            }
        }
        if (typeNames.size > 0) add(relModuleSpecifier(moduleRef, TYPES_REF), [...typeNames].sort().join(", "));
    }

    const kw = typeOnly ? "import type" : "import";
    return [...bySpec.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([spec, bindings]) => `${kw} { ${[...bindings].sort().join(", ")} } from "${spec}";`);
}

/** Run the domain's claimed-function renderer over the claimed functions this module owns,
 *  returning a name→rendering map (empty when the module owns none). */
function renderClaimed(content: ModuleContent, deps: ModuleEmitDeps): Map<string, ClaimedFunctionRendering> {
    const claimed = content.functions.filter((fn) => deps.claimedFunctionNames.has(fn.name));
    if (claimed.length === 0) return new Map();
    if (deps.renderClaimedFunctions === undefined) {
        throw new Error("module owns claimed functions but no renderClaimedFunctions hook was provided");
    }
    const renderings = deps.renderClaimedFunctions(claimed);
    return new Map(claimed.map((fn, i) => [fn.name, renderings[i]!]));
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

// Validator/formatter attachments ride in the field's `extensions['schema']` slice (a
// schema-domain concern). The generic module emitter still needs the referenced factory names
// to wire each model file's imports from the factory's source module — a transitional read of
// the well-known slice keeps that import wiring here without depending on `@keyma/schema`.
type SchemaFieldSlice = {
    validators?: { name: string }[];
    formatters?: { phase: string; spec: { name: string } }[];
};
function schemaSlice(field: IRField): SchemaFieldSlice | undefined {
    return field.extensions?.["schema"] as SchemaFieldSlice | undefined;
}

export function collectFactoryNames(fields: readonly IRField[], which: "validators" | "formatters", formPhasesOnly: boolean): Set<string> {
    const out = new Set<string>();
    for (const f of fields) {
        const slice = schemaSlice(f);
        if (which === "validators") {
            for (const v of slice?.validators ?? []) out.add(v.name);
        } else {
            for (const fmt of slice?.formatters ?? []) {
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
    if (field.deprecated !== undefined) {
        body.push(typeof field.deprecated === "string" ? `@deprecated ${field.deprecated}` : "@deprecated");
    }
    if (body.length === 0) return [];
    if (body.length === 1) return [`    /** ${body[0]} */`];
    return ["    /**", ...body.map((l) => `     * ${l}`), "     */"];
}

import type {
    IRValidatorDeclaration,
    IRFormatterDeclaration,
    IRFunctionDeclaration,
} from "@keyma/ir";
import { stmtToJs } from "./emit-expression.js";
import { irTypeToTs, jsTypeGuard, irTypeLabel } from "./ir-type-to-ts.js";

export type ValidatorEmitFiles = {
    factoriesJs: string;
    factoriesDts: string;
    registryJs: string;
    registryDts: string;
};

export type FormatterEmitFiles = {
    factoriesJs: string;
    factoriesDts: string;
    registryJs: string;
    registryDts: string;
};

export type RegistryOptions = {
    /** Names of compiled utility functions to import into the registry module. */
    functionNames: readonly string[];
};

/** `import { a, b } from "./functions.js";` header, or empty when there are none. */
function functionsImport(functionNames: readonly string[]): string {
    if (functionNames.length === 0) return "";
    return `import { ${functionNames.join(", ")} } from "./functions.js";\n\n`;
}

// ─── Validators ───────────────────────────────────────────────────────────────

export function emitValidatorFiles(
    declarations: IRValidatorDeclaration[],
    opts: RegistryOptions,
): ValidatorEmitFiles {
    return {
        factoriesJs: emitValidatorFactoriesJs(declarations),
        factoriesDts: emitValidatorFactoriesDts(declarations),
        registryJs: emitValidatorRegistryJs(declarations, opts),
        registryDts: emitValidatorRegistryDts(),
    };
}

// ─── Utility functions ─────────────────────────────────────────────────────────

export type FunctionEmitFiles = { functionsJs: string; functionsDts: string };

/** Emit compiled project-local utility functions as an ES module + types. */
export function emitFunctionFiles(
    declarations: IRFunctionDeclaration[],
    embeddedNames?: ReadonlyMap<string, string>,
): FunctionEmitFiles {
    const js: string[] = [];
    const dts: string[] = [];
    for (const decl of declarations) {
        const params = decl.params.map((p) => p.name).join(", ");
        const body = decl.statements.map((s) => stmtToJs(s, "    ")).join("\n");
        js.push(`export function ${decl.name}(${params}) {\n${body}\n}`);

        const dtsParams = decl.params.map((p) => `${p.name}: ${irTypeToTs(p.type, embeddedNames)}`).join(", ");
        dts.push(`export declare function ${decl.name}(${dtsParams}): ${irTypeToTs(decl.returnType, embeddedNames)};`);
    }
    return { functionsJs: js.join("\n\n") + "\n", functionsDts: dts.join("\n") + "\n" };
}

function emitValidatorFactoriesJs(declarations: IRValidatorDeclaration[]): string {
    if (declarations.length === 0) return "";
    const lines: string[] = [];
    for (const decl of declarations) {
        if (decl.factoryParams.length === 0) {
            // Parameterless: export const isRequired = () => ({ __validatorName: "required" });
            lines.push(`export const ${decl.name.replace(/-/g, "_")} = () => ({ __validatorName: ${JSON.stringify(decl.name)} });`);
        } else {
            // Parameterised: export const minLength = (value) => ({ __validatorName: "minLength", params: { value } });
            const paramList = decl.factoryParams.map((p) => p.name).join(", ");
            const paramsObj = `{ ${decl.factoryParams.map((p) => p.name).join(", ")} }`;
            lines.push(`export const ${decl.name.replace(/-/g, "_")} = (${paramList}) => ({ __validatorName: ${JSON.stringify(decl.name)}, params: ${paramsObj} });`);
        }
    }
    return lines.join("\n") + "\n";
}

function emitValidatorFactoriesDts(declarations: IRValidatorDeclaration[]): string {
    if (declarations.length === 0) return "";
    const lines: string[] = [
        `import type { ValidatorRef } from "@keyma/dsl";`,
        "",
    ];
    for (const decl of declarations) {
        const exportName = decl.name.replace(/-/g, "_");
        // Emit the name as a literal type argument so the compiler can read it off
        // the call expression's type when this factory is imported elsewhere.
        const ref = `ValidatorRef<${JSON.stringify(decl.name)}>`;
        if (decl.factoryParams.length === 0) {
            lines.push(`export declare const ${exportName}: () => ${ref};`);
        } else {
            const paramList = decl.factoryParams.map((p) => `${p.name}: unknown`).join(", ");
            lines.push(`export declare const ${exportName}: (${paramList}) => ${ref};`);
        }
    }
    return lines.join("\n") + "\n";
}

function emitValidatorRegistryJs(declarations: IRValidatorDeclaration[], opts: RegistryOptions): string {
    const entries: string[] = [];
    for (const decl of declarations) {
        entries.push(emitValidatorEntry(decl));
    }
    return functionsImport(opts.functionNames) + [
        `export function createValidatorRegistry() {`,
        `    return new Map([`,
        entries.map((e) => `        ${e}`).join(",\n"),
        `    ]);`,
        `}`,
        "",
    ].join("\n");
}

function emitValidatorEntry(decl: IRValidatorDeclaration): string {
    const { valueParam, fieldParam, ctxParam } = resolveInnerParams(decl.body.params);
    const specParam = "spec";

    // Build param list: (value, spec, field, ctx)
    const paramNames = [valueParam, specParam, fieldParam, ctxParam].filter(Boolean);

    // Prepend factory param extractions
    const factoryExtractions = decl.factoryParams
        .map((p) => `        const ${p.name} = ${specParam}.${p.name};`)
        .join("\n");

    // Runtime input guard: reject values that do not match the declared input type.
    const guard = jsTypeGuard(decl.inputType, valueParam);
    const guardLine = guard !== null
        ? `        if (!(${guard})) return ${JSON.stringify(`expected ${irTypeLabel(decl.inputType)}`)};`
        : "";

    const body = decl.body.statements.map((s) => stmtToJs(s, "        ")).join("\n");

    const fnBody = [
        factoryExtractions,
        guardLine,
        body,
    ].filter(Boolean).join("\n");

    return `[${JSON.stringify(decl.name)}, (${paramNames.join(", ")}) => {\n${fnBody}\n    }]`;
}

function emitValidatorRegistryDts(): string {
    return [
        `import type { ValidatorRegistry } from "@keyma/runtime-js";`,
        "",
        `export declare function createValidatorRegistry(): ValidatorRegistry;`,
        "",
    ].join("\n");
}

// ─── Formatters ───────────────────────────────────────────────────────────────

export function emitFormatterFiles(
    declarations: IRFormatterDeclaration[],
    opts: RegistryOptions,
): FormatterEmitFiles {
    return {
        factoriesJs: emitFormatterFactoriesJs(declarations),
        factoriesDts: emitFormatterFactoriesDts(declarations),
        registryJs: emitFormatterRegistryJs(declarations, opts),
        registryDts: emitFormatterRegistryDts(),
    };
}

function emitFormatterFactoriesJs(declarations: IRFormatterDeclaration[]): string {
    if (declarations.length === 0) return "";
    const lines: string[] = [];
    for (const decl of declarations) {
        if (decl.factoryParams.length === 0) {
            lines.push(`export const ${decl.name.replace(/-/g, "_")} = () => ({ __formatterName: ${JSON.stringify(decl.name)} });`);
        } else {
            const paramList = decl.factoryParams.map((p) => p.name).join(", ");
            const paramsObj = `{ ${decl.factoryParams.map((p) => p.name).join(", ")} }`;
            lines.push(`export const ${decl.name.replace(/-/g, "_")} = (${paramList}) => ({ __formatterName: ${JSON.stringify(decl.name)}, params: ${paramsObj} });`);
        }
    }
    return lines.join("\n") + "\n";
}

function emitFormatterFactoriesDts(declarations: IRFormatterDeclaration[]): string {
    if (declarations.length === 0) return "";
    const lines: string[] = [
        `import type { FormatterRef } from "@keyma/dsl";`,
        "",
    ];
    for (const decl of declarations) {
        const exportName = decl.name.replace(/-/g, "_");
        const ref = `FormatterRef<${JSON.stringify(decl.name)}>`;
        if (decl.factoryParams.length === 0) {
            lines.push(`export declare const ${exportName}: () => ${ref};`);
        } else {
            const paramList = decl.factoryParams.map((p) => `${p.name}: unknown`).join(", ");
            lines.push(`export declare const ${exportName}: (${paramList}) => ${ref};`);
        }
    }
    return lines.join("\n") + "\n";
}

function emitFormatterRegistryJs(declarations: IRFormatterDeclaration[], opts: RegistryOptions): string {
    const entries: string[] = [];
    for (const decl of declarations) {
        entries.push(emitFormatterEntry(decl));
    }
    return functionsImport(opts.functionNames) + [
        `export function createFormatterRegistry() {`,
        `    return new Map([`,
        entries.map((e) => `        ${e}`).join(",\n"),
        `    ]);`,
        `}`,
        "",
    ].join("\n");
}

function emitFormatterEntry(decl: IRFormatterDeclaration): string {
    const { valueParam, ctxParam } = resolveInnerParams(decl.body.params);
    const specParam = "spec";

    const paramNames = [valueParam, specParam, ctxParam].filter(Boolean);

    const factoryExtractions = decl.factoryParams
        .map((p) => `        const ${p.name} = ${specParam}.${p.name};`)
        .join("\n");

    // Runtime input guard: formatters throw on a type mismatch.
    const guard = jsTypeGuard(decl.inputType, valueParam);
    const guardLine = guard !== null
        ? `        if (!(${guard})) throw new TypeError(${JSON.stringify(`${decl.name} formatter expected ${irTypeLabel(decl.inputType)}`)});`
        : "";

    const body = decl.body.statements.map((s) => stmtToJs(s, "        ")).join("\n");

    const fnBody = [factoryExtractions, guardLine, body].filter(Boolean).join("\n");

    return `[${JSON.stringify(decl.name)}, (${paramNames.join(", ")}) => {\n${fnBody}\n    }]`;
}

function emitFormatterRegistryDts(): string {
    return [
        `import type { FormatterRegistry } from "@keyma/runtime-js";`,
        "",
        `export declare function createFormatterRegistry(): FormatterRegistry;`,
        "",
    ].join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type InnerParamNames = {
    valueParam: string;
    fieldParam: string;
    ctxParam: string;
};

function resolveInnerParams(params: Array<{ name: string; role: string }>): InnerParamNames {
    let valueParam = "_value";
    let fieldParam = "_field";
    let ctxParam = "_ctx";
    for (const p of params) {
        if (p.role === "value") valueParam = p.name;
        else if (p.role === "field") fieldParam = p.name;
        else if (p.role === "context") ctxParam = p.name;
    }
    return { valueParam, fieldParam, ctxParam };
}

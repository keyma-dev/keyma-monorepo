import type {
    IRValidatorDeclaration,
    IRFormatterDeclaration,
    IRFunctionDeclaration,
} from "@keyma/ir";
import { stmtToJs } from "./emit-expression.js";
import { irTypeToTs, jsTypeGuard, irTypeLabel } from "./ir-type-to-ts.js";

/** A factory identifier safe for a JS binding (validator/formatter names are already identifiers). */
export function factoryIdent(name: string): string {
    return name.replace(/-/g, "_");
}

/** `import { a, b } from "<spec>";` header, or empty when there are none. */
function functionsImport(functionNames: readonly string[], spec: string): string {
    if (functionNames.length === 0) return "";
    return `import { ${functionNames.map(factoryIdent).join(", ")} } from "${spec}";\n\n`;
}

// ─── Direct-ref factory call (spliced into schema metadata) ────────────────────

/**
 * Build the factory call that materializes a validator/formatter implementation in
 * the schema metadata, e.g. `minLength(2)` / `trim()`. Field params (`{value: 2}`)
 * are ordered positionally by the declaration's factory parameter list.
 */
export function buildFactoryCall(
    name: string,
    params: Record<string, unknown> | undefined,
    factoryParams: readonly { name: string }[],
): string {
    const args = factoryParams.map((p) => params?.[p.name]);
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
    const rendered = args.map((a) => (a === undefined ? "undefined" : JSON.stringify(a)));
    return `${factoryIdent(name)}(${rendered.join(", ")})`;
}

// ─── Validators ───────────────────────────────────────────────────────────────

/** Emit `validators.js`: one direct-ref factory `export const` per used validator. */
export function emitValidatorsJs(
    decls: readonly IRValidatorDeclaration[],
    functionNames: readonly string[],
): string {
    return functionsImport(functionNames, "./functions.js") + decls.map(emitValidatorFactory).join("\n\n") + "\n";
}

export function emitValidatorsDts(decls: readonly IRValidatorDeclaration[]): string {
    const lines = [`import type { ValidatorFn } from "./types.js";`, ""];
    for (const d of decls) lines.push(`export declare const ${factoryIdent(d.name)}: (...args: unknown[]) => ValidatorFn;`);
    return lines.join("\n") + "\n";
}

function emitValidatorFactory(decl: IRValidatorDeclaration): string {
    const { valueParam, fieldParam } = resolveInnerParams(decl.body.params);
    const factoryParamList = decl.factoryParams.map((p) => p.name).join(", ");
    const innerParamList = innerParams(decl.body.params, ["value", "field", "context"]);

    const guard = jsTypeGuard(decl.inputType, valueParam);
    const fieldRef = fieldParam ?? "undefined";
    const message = JSON.stringify(`expected ${irTypeLabel(decl.inputType)}`);
    const guardLine = guard !== null
        ? `    if (!(${guard})) return { field: ${fieldRef}, code: "type_error", message: ${message} };`
        : "";
    const body = decl.body.statements.map((s) => stmtToJs(s, "    ")).join("\n");
    const fnBody = [guardLine, body].filter(Boolean).join("\n");

    return `export const ${factoryIdent(decl.name)} = (${factoryParamList}) => (${innerParamList}) => {\n${fnBody}\n};`;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

/** Emit `formatters.js`: one direct-ref factory `export const` per used formatter. */
export function emitFormattersJs(
    decls: readonly IRFormatterDeclaration[],
    functionNames: readonly string[],
): string {
    return functionsImport(functionNames, "./functions.js") + decls.map(emitFormatterFactory).join("\n\n") + "\n";
}

export function emitFormattersDts(decls: readonly IRFormatterDeclaration[]): string {
    const lines = [`import type { FormatterFn } from "./types.js";`, ""];
    for (const d of decls) lines.push(`export declare const ${factoryIdent(d.name)}: (...args: unknown[]) => FormatterFn;`);
    return lines.join("\n") + "\n";
}

function emitFormatterFactory(decl: IRFormatterDeclaration): string {
    const { valueParam } = resolveInnerParams(decl.body.params);
    const factoryParamList = decl.factoryParams.map((p) => p.name).join(", ");
    const innerParamList = innerParams(decl.body.params, ["value", "context"]);

    const guard = jsTypeGuard(decl.inputType, valueParam);
    const guardLine = guard !== null
        ? `    if (!(${guard})) throw new TypeError(${JSON.stringify(`${decl.name} formatter expected ${irTypeLabel(decl.inputType)}`)});`
        : "";
    const body = decl.body.statements.map((s) => stmtToJs(s, "    ")).join("\n");
    const fnBody = [guardLine, body].filter(Boolean).join("\n");

    return `export const ${factoryIdent(decl.name)} = (${factoryParamList}) => (${innerParamList}) => {\n${fnBody}\n};`;
}

// ─── Utility functions (functions.js) ──────────────────────────────────────────

export type FunctionEmitFiles = { functionsJs: string; functionsDts: string };

/** Emit compiled project-local utility functions as an ES module + types. */
export function emitFunctionFiles(
    declarations: readonly IRFunctionDeclaration[],
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

type InnerParamNames = { valueParam: string; fieldParam: string | undefined };

function resolveInnerParams(params: ReadonlyArray<{ name: string; role: string }>): InnerParamNames {
    let valueParam = "_value";
    let fieldParam: string | undefined;
    for (const p of params) {
        if (p.role === "value") valueParam = p.name;
        else if (p.role === "field") fieldParam = p.name;
    }
    return { valueParam, fieldParam };
}

/** Emit the inner function parameter list in declaration order (value[, field][, context]). */
function innerParams(params: ReadonlyArray<{ name: string; role: string }>, _order: string[]): string {
    return params.map((p) => p.name).join(", ");
}

import type { IRFunctionDeclaration } from "@keyma/core/ir";
import { factoryIdent, stmtToJs, jsTypeGuard, irTypeLabel } from "@keyma/compiler/backend-js";
import { validatorShape } from "../backend-common/validator-shape.js";

// The schema domain owns the runtime `ValidatorFn`/`FormatterFn` wrapper emission. Each
// validator/formatter factory is an ordinary `IRFunctionDeclaration` (its body returns a
// typed inner arrow); `validatorShape` recovers the factory params, the inner positional
// params (value/field/context) and the input type so this re-emits the same factory the
// `<Class>.schema` metadata calls. Generic project-local utility functions stay in
// `@keyma/compiler` (`functions.js`).

/** `import { a, b } from "<spec>";` header, or empty when there are none. */
function functionsImport(functionNames: readonly string[], spec: string): string {
    if (functionNames.length === 0) return "";
    return `import { ${functionNames.map(factoryIdent).join(", ")} } from "${spec}";\n\n`;
}

// ─── Direct-ref factory call (spliced into schema metadata) ────────────────────

/**
 * Build the factory call that materializes a validator/formatter implementation in the
 * schema metadata, e.g. `minLength(2)` / `trim()`. Field params (`{value: 2}`) are ordered
 * positionally by the factory function's parameter list.
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
    decls: readonly IRFunctionDeclaration[],
    functionNames: readonly string[],
): string {
    return functionsImport(functionNames, "./functions.js") + decls.map(emitValidatorFactory).join("\n\n") + "\n";
}

export function emitValidatorsDts(decls: readonly IRFunctionDeclaration[]): string {
    const lines = [`import type { ValidatorFn } from "./types.js";`, ""];
    for (const d of decls) lines.push(`export declare const ${factoryIdent(d.name)}: (...args: unknown[]) => ValidatorFn;`);
    return lines.join("\n") + "\n";
}

function emitValidatorFactory(decl: IRFunctionDeclaration): string {
    const s = validatorShape(decl);
    const factoryParamList = s.factoryParams.map((p) => p.name).join(", ");
    const innerParamList = s.innerParams.join(", ");

    const guard = jsTypeGuard(s.inputType, s.valueParam);
    const fieldRef = s.fieldParam ?? "undefined";
    const message = JSON.stringify(`expected ${irTypeLabel(s.inputType)}`);
    const guardLine = guard !== null
        ? `    if (!(${guard})) return { field: ${fieldRef}, code: "type_error", message: ${message} };`
        : "";
    const body = s.statements.map((st) => stmtToJs(st, "    ")).join("\n");
    const fnBody = [guardLine, body].filter(Boolean).join("\n");

    return `export const ${factoryIdent(decl.name)} = (${factoryParamList}) => (${innerParamList}) => {\n${fnBody}\n};`;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

/** Emit `formatters.js`: one direct-ref factory `export const` per used formatter. */
export function emitFormattersJs(
    decls: readonly IRFunctionDeclaration[],
    functionNames: readonly string[],
): string {
    return functionsImport(functionNames, "./functions.js") + decls.map(emitFormatterFactory).join("\n\n") + "\n";
}

export function emitFormattersDts(decls: readonly IRFunctionDeclaration[]): string {
    const lines = [`import type { FormatterFn } from "./types.js";`, ""];
    for (const d of decls) lines.push(`export declare const ${factoryIdent(d.name)}: (...args: unknown[]) => FormatterFn;`);
    return lines.join("\n") + "\n";
}

function emitFormatterFactory(decl: IRFunctionDeclaration): string {
    const s = validatorShape(decl);
    const factoryParamList = s.factoryParams.map((p) => p.name).join(", ");
    const innerParamList = s.innerParams.join(", ");

    const guard = jsTypeGuard(s.inputType, s.valueParam);
    const guardLine = guard !== null
        ? `    if (!(${guard})) throw new TypeError(${JSON.stringify(`${decl.name} formatter expected ${irTypeLabel(s.inputType)}`)});`
        : "";
    const body = s.statements.map((st) => stmtToJs(st, "    ")).join("\n");
    const fnBody = [guardLine, body].filter(Boolean).join("\n");

    return `export const ${factoryIdent(decl.name)} = (${factoryParamList}) => (${innerParamList}) => {\n${fnBody}\n};`;
}

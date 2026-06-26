import type { IRFunctionDeclaration, KeymaIR } from "@keyma/core/ir";
import { factoryIdent, stmtToJs, jsTypeGuard, irTypeLabel, type ClaimedFunctionRendering } from "@keyma/compiler/backend-js";
import { validatorShape } from "../backend-common/validator-shape.js";
import { fieldValidators, fieldFormatters } from "../ir/extensions.js";

// The schema domain owns the runtime `ValidatorFn`/`FormatterFn` wrapper emission. Each
// validator/formatter factory is an ordinary `IRFunctionDeclaration` (its body returns a
// typed inner arrow); `validatorShape` recovers the factory params, the inner positional
// params (value/field/context) and the input type so this re-emits the same factory the
// `<Class>.schema` metadata calls. The factory is spliced into its SOURCE module by the
// generic module emitter, which resolves any utility-function imports its body needs.

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

// ─── Claimed-function rendering (validators/formatters into their source module) ───

/** Validator/formatter factory names referenced by any field's `@Validate`/`@Format`. */
export function factoryNames(ir: KeymaIR): { validatorNames: ReadonlySet<string>; formatterNames: ReadonlySet<string> } {
    const validatorNames = new Set<string>();
    const formatterNames = new Set<string>();
    for (const cls of ir.classes) {
        for (const field of cls.fields) {
            for (const v of fieldValidators(field)) validatorNames.add(v.name);
            for (const f of fieldFormatters(field)) formatterNames.add(f.spec.name);
        }
    }
    return { validatorNames, formatterNames };
}

/**
 * Render each claimed factory with its runtime guard wrapper, for splicing into its source
 * module. The generic module emitter passes the module's claimed subset (in order) and resolves
 * the cross-module utility-function imports each body references.
 */
export function renderClaimedFunctions(
    decls: readonly IRFunctionDeclaration[],
    ir: KeymaIR,
): readonly ClaimedFunctionRendering[] {
    const { validatorNames } = factoryNames(ir);
    return decls.map((decl) =>
        validatorNames.has(decl.name)
            ? { js: emitValidatorFactory(decl) + "\n", dts: declConst(decl, "ValidatorFn"), dtsTypeImports: ["ValidatorFn"] }
            : { js: emitFormatterFactory(decl) + "\n", dts: declConst(decl, "FormatterFn"), dtsTypeImports: ["FormatterFn"] },
    );
}

function declConst(decl: IRFunctionDeclaration, marker: "ValidatorFn" | "FormatterFn"): string {
    return `export declare const ${factoryIdent(decl.name)}: (...args: unknown[]) => ${marker};\n`;
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

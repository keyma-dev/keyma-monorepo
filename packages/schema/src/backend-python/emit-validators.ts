import type { IRFunctionDeclaration, KeymaIR } from "@keyma/core/ir";
import {
    factoryIdent, renderStatements,
    irTypeGuard, irTypeLabel, emitLiteral,
} from "@keyma/compiler/backend-python";
import { validatorShape } from "../backend-common/validator-shape.js";
import { fieldValidators, fieldFormatters } from "../ir/extensions.js";

// The schema domain owns the runtime validator/formatter wrapper emission. Each
// validator/formatter factory is an ordinary `IRFunctionDeclaration` (its body returns a
// typed inner arrow); `validatorShape` recovers the factory params, the inner positional
// params (value/field/context) and the input type so this re-emits the same factory the
// `<Class>.schema` metadata calls. Generic project-local utility functions stay in
// `@keyma/compiler` (plain `def`s in their source module). Validator/formatter factories are
// claimed here and rendered (with the runtime guard wrapper) co-located in their source module
// by the generic module emitter.

/**
 * Render a factory parameter for the def signature. An optional param (a `?` or default
 * in the source factory) gets `=None` so a call site may omit it; the lowered body
 * already guards such params (e.g. `flags or ""`), mirroring the JS source.
 */
function pyFactoryParam(p: { name: string; optional?: boolean }): string {
    return p.optional === true ? `${p.name}=None` : p.name;
}

/**
 * Rewrite portable cross-field access `<ctx>.object.<field>` to a Python dict lookup
 * `<ctx>.object.get("<field>")`. The Python runtime hands validators/formatters a
 * context whose `.object` is the record **dict**, so generic member lowering
 * (`ctx.object.field`) would be attribute access on a dict and fail at runtime.
 * No-op when the inner function declares no context parameter.
 */
function rewriteContextAccess(code: string, ctxParam: string | undefined): string {
    if (ctxParam === undefined) return code;
    const re = new RegExp(`\\b${ctxParam}\\.object\\.([A-Za-z_][A-Za-z0-9_]*)`, "g");
    return code.replace(re, `${ctxParam}.object.get("$1")`);
}

// ─── Direct-ref factory call (spliced into schema metadata) ────────────────────

/** Build the factory call that materializes a validator/formatter, e.g. `min_length(2)`.
 *  Field params are ordered positionally by the factory function's parameter list. */
export function buildFactoryCall(
    name: string,
    params: Record<string, unknown> | undefined,
    factoryParams: readonly { name: string }[],
): string {
    const args = factoryParams.map((p) => params?.[p.name]);
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
    return `${factoryIdent(name)}(${args.map((a) => emitLiteral(a)).join(", ")})`;
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
 * Render each claimed factory with its runtime guard wrapper (a `def` returning the typed inner
 * `_v`/`_f`), for splicing into its source module by the generic module emitter. The schema
 * metadata calls each factory by name (imported cross-module where needed).
 */
export function renderClaimedFunctions(
    decls: readonly IRFunctionDeclaration[],
    ir: KeymaIR,
): readonly string[] {
    const { validatorNames } = factoryNames(ir);
    return decls.map((d) => (validatorNames.has(d.name) ? emitValidatorFactory(d) : emitFormatterFactory(d)));
}

// ─── Validators ────────────────────────────────────────────────────────────────

function emitValidatorFactory(decl: IRFunctionDeclaration): string {
    const s = validatorShape(decl);
    const factoryParamList = s.factoryParams.map(pyFactoryParam).join(", ");
    const innerParamList = s.innerParams.join(", ");
    const valueParam = s.valueParam;
    const fieldParam = s.fieldParam ?? "None";
    const ctxParam = s.ctxParam;

    const lines = [`def ${factoryIdent(decl.name)}(${factoryParamList}):`, `    def _v(${innerParamList}):`];
    const guard = irTypeGuard(s.inputType, valueParam);
    if (guard !== null) {
        const message = JSON.stringify(`expected ${irTypeLabel(s.inputType)}`);
        lines.push(`        if not (${guard}):`);
        lines.push(`            return {"field": ${fieldParam}, "code": "type_error", "message": ${message}}`);
    }
    if (s.statements.length > 0) {
        lines.push(rewriteContextAccess(renderStatements(s.statements, "        "), ctxParam));
    }
    lines.push(`    return _v`);
    return lines.join("\n");
}

// ─── Formatters ─────────────────────────────────────────────────────────────────

function emitFormatterFactory(decl: IRFunctionDeclaration): string {
    const s = validatorShape(decl);
    const factoryParamList = s.factoryParams.map(pyFactoryParam).join(", ");
    const innerParamList = s.innerParams.join(", ");
    const valueParam = s.valueParam;
    const ctxParam = s.ctxParam;

    const lines = [`def ${factoryIdent(decl.name)}(${factoryParamList}):`, `    def _f(${innerParamList}):`];
    const guard = irTypeGuard(s.inputType, valueParam);
    if (guard !== null) {
        const msg = `${decl.name} formatter expected ${irTypeLabel(s.inputType)}, got `;
        lines.push(`        if not (${guard}):`);
        lines.push(`            raise TypeError(${JSON.stringify(msg)} + type(${valueParam}).__name__)`);
    }
    if (s.statements.length > 0) {
        lines.push(rewriteContextAccess(renderStatements(s.statements, "        "), ctxParam));
    }
    lines.push(`    return _f`);
    return lines.join("\n");
}

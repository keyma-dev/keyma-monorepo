import type { IRFunctionDeclaration, IRExpression, KeymaIR } from "@keyma/core/ir";
import {
    factoryIdent, stmtToCpp, rewriteContextAccess,
    valueBinding, irTypeGuard, irTypeLabel, exprToCpp,
    type ReturnLowerer,
} from "@keyma/compiler/backend-cpp";
import { validatorShape } from "../backend-common/validator-shape.js";
import { fieldValidators, fieldFormatters } from "../ir/extensions.js";

// The schema domain owns the runtime `ValidatorFn`/`FormatterFn` wrapper emission. Each
// validator/formatter factory is an ordinary `IRFunctionDeclaration` (its body returns a
// typed inner lambda); `validatorShape` recovers the factory params, the inner positional
// params (value/field/context) and the input type so this re-emits the same factory the
// `schema()` metadata calls. Generic project-local utility functions stay in
// `@keyma/compiler` (`functions.hpp`).

/** Render a (literal) factory argument as a C++ expression. */
function cppArg(v: unknown): string {
    if (v === null || v === undefined) return "nullptr";
    // A string arg becomes an owning std::pmr::string so the captured value has full
    // string comparison (==, <) in the body and an `auto` factory param deduces a real
    // string type — not const char*, whose `==` would be a pointer compare.
    if (typeof v === "string") return `std::pmr::string{${JSON.stringify(v)}}`;
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return String(v);
    // An array arg becomes a concrete std::pmr::vector so an `auto` factory param can
    // deduce it (a braced-init-list cannot be deduced). Element type from the contents.
    if (Array.isArray(v)) {
        const elems = v.map(cppArg).join(", ");
        if (v.length > 0 && v.every((x) => typeof x === "string")) return `std::pmr::vector<std::pmr::string>{${elems}}`;
        if (v.length > 0 && v.every((x) => typeof x === "number")) return `std::pmr::vector<double>{${elems}}`;
        return `{${elems}}`;
    }
    return "nullptr";
}

/**
 * Render a factory parameter declaration. A required param is a deduced `auto`. An
 * optional param (a `?` or default in the source factory) needs a CONCRETE type with a
 * default value: a template parameter cannot be deduced from a default *function*
 * argument, so `auto x = …` would fail when the arg is omitted. Optional validator/
 * formatter params are string-typed in practice (regex `flags`, IP `version`), so an
 * owning `std::pmr::string` (default empty) both omits cleanly and accepts a supplied
 * string arg without dangling (string_view would alias the call-site temporary).
 */
function cppFactoryParam(p: { name: string; optional?: boolean }): string {
    return p.optional === true ? `std::pmr::string ${p.name} = {}` : `auto ${p.name}`;
}

// ─── Direct-ref factory call (spliced into schema metadata) ────────────────────

/**
 * Build the factory call that materializes a validator/formatter for the schema
 * metadata, e.g. `keyma::validators::min_length(2)`. Field params (`{value: 2}`) are
 * ordered positionally by the factory function's parameter list. `qualifiedNs` is the
 * fully-qualified namespace (e.g. `keyma::validators`).
 */
export function buildFactoryCall(
    name: string,
    params: Record<string, unknown> | undefined,
    factoryParams: readonly { name: string }[],
    qualifiedNs: string,
): string {
    const args = factoryParams.map((p) => params?.[p.name]);
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
    return `${qualifiedNs}::${factoryIdent(name)}(${args.map(cppArg).join(", ")})`;
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
 * Render each claimed factory with its runtime guard wrapper (an `inline keyma::ValidatorFn`/
 * `keyma::FormatterFn` free function), for splicing into its source module's namespace by the
 * generic module emitter. The schema metadata calls each fully qualified by that namespace.
 */
export function renderClaimedFunctions(
    decls: readonly IRFunctionDeclaration[],
    ir: KeymaIR,
): readonly string[] {
    const { validatorNames } = factoryNames(ir);
    return decls.map((d) => (validatorNames.has(d.name) ? emitValidatorFactory(d) : emitFormatterFactory(d)));
}

function emitValidatorFactory(decl: IRFunctionDeclaration): string {
    const s = validatorShape(decl);
    const factoryParams = s.factoryParams.map(cppFactoryParam).join(", ");
    const captures = s.factoryParams.map((p) => p.name).join(", ");
    const valueParam = s.valueParam;
    const ctxParam = s.ctxParam;
    const fieldName = s.fieldParam ?? "__field";
    const ctxName = ctxParam ?? "__ctx";
    const binding = valueBinding(s.inputType, "__raw");
    const guard = irTypeGuard(s.inputType, "__raw");

    const E = "std::expected<void, keyma::ValidationError>";
    const veStr = (e: IRExpression | undefined, fallback: string): string =>
        `std::pmr::string(${e !== undefined ? exprToCpp(e) : fallback}, __raw.get_allocator())`;
    const buildVE = (obj: Extract<IRExpression, { kind: "object" }>): string => {
        const prop = (k: string) => obj.properties.find((p) => p.key === k)?.value;
        return `keyma::ValidationError{${veStr(prop("field"), fieldName)}, ${veStr(prop("code"), '""')}, ${veStr(prop("message"), '""')}}`;
    };
    const result = (expr: IRExpression | null): string => {
        if (expr === null || (expr.kind === "literal" && expr.value === null)) return `${E}{}`;
        if (expr.kind === "object") return `${E}(std::unexpected(${buildVE(expr)}))`;
        if (expr.kind === "conditional") {
            return `(${exprToCpp(expr.condition)} ? ${result(expr.whenTrue)} : ${result(expr.whenFalse)})`;
        }
        return `${E}{}`;
    };
    const ret: ReturnLowerer = (value, indent) => `${indent}return ${result(value)};`;

    const lines: string[] = [
        `inline keyma::ValidatorFn ${factoryIdent(decl.name)}(${factoryParams}) {`,
        `    return keyma::ValidatorFn{[${captures}](const keyma::Value& __raw, [[maybe_unused]] std::string_view ${fieldName}, [[maybe_unused]] const keyma::Context& ${ctxName})`,
        `        -> ${E} {`,
    ];
    if (guard !== null) {
        const label = JSON.stringify(`expected ${irTypeLabel(s.inputType)}`);
        lines.push(
            `        if (!(${guard})) return ${E}(std::unexpected(keyma::ValidationError{` +
            `std::pmr::string(${fieldName}, __raw.get_allocator()), ` +
            `std::pmr::string("type_error", __raw.get_allocator()), ` +
            `std::pmr::string(${label}, __raw.get_allocator())}));`,
        );
    }
    lines.push(`        [[maybe_unused]] ${binding.cppType} ${valueParam} = ${binding.init};`);
    for (const stmt of s.statements) lines.push(stmtToCpp(stmt, "        ", ret));
    lines.push(`    }};`, `}`);
    return rewriteContextAccess(lines.join("\n"), ctxParam);
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function emitFormatterFactory(decl: IRFunctionDeclaration): string {
    const s = validatorShape(decl);
    const factoryParams = s.factoryParams.map(cppFactoryParam).join(", ");
    const captures = s.factoryParams.map((p) => p.name).join(", ");
    const valueParam = s.valueParam;
    const ctxParam = s.ctxParam;
    const ctxName = ctxParam ?? "__ctx";
    const binding = valueBinding(s.inputType, "__raw");
    const guard = irTypeGuard(s.inputType, "__raw");

    const ret: ReturnLowerer = (value, indent) =>
        value === null
            ? `${indent}return keyma::Value{};`
            : `${indent}return keyma::to_value(${exprToCpp(value)}, __raw.get_allocator());`;

    const lines: string[] = [
        `inline keyma::FormatterFn ${factoryIdent(decl.name)}(${factoryParams}) {`,
        `    return keyma::FormatterFn{[${captures}](const keyma::Value& __raw, [[maybe_unused]] const keyma::Context& ${ctxName}) -> keyma::Value {`,
    ];
    if (guard !== null) {
        const msg = JSON.stringify(`${decl.name} formatter expected ${irTypeLabel(s.inputType)}`);
        lines.push(`        if (!(${guard})) throw std::runtime_error(${msg});`);
    }
    lines.push(`        [[maybe_unused]] ${binding.cppType} ${valueParam} = ${binding.init};`);
    for (const stmt of s.statements) lines.push(stmtToCpp(stmt, "        ", ret));
    lines.push(`    }};`, `}`);
    return rewriteContextAccess(lines.join("\n"), ctxParam);
}

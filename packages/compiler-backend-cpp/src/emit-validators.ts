import type {
    IRValidatorDeclaration,
    IRFormatterDeclaration,
    IRFunctionDeclaration,
    IRStatement,
    IRExpression,
} from "@keyma/ir";
import { exprToCpp, type ExprOpts } from "./emit-expression.js";
import { valueBinding, irTypeGuard, irTypeLabel, irTypeToCpp } from "./ir-type-to-cpp.js";

/** A factory/function name as a valid C++ identifier. */
export function factoryIdent(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

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

/**
 * Build the factory call that materializes a validator/formatter for the schema
 * metadata, e.g. `keyma::validators::min_length(2)`. `qualifiedNs` is the fully-
 * qualified namespace (e.g. `keyma::validators`).
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

// ─── Statement lowering (shared with methods/functions) ───────────────────────

/** Lowers a `return` statement; the strategy differs by body kind (plain / validator / formatter). */
export type ReturnLowerer = (value: IRExpression | null, indent: string) => string;

/** Plain return for methods/functions. */
export const plainReturn: ReturnLowerer = (value, indent) =>
    value === null ? `${indent}return;` : `${indent}return ${exprToCpp(value)};`;

export function stmtToCpp(stmt: IRStatement, indent: string, ret: ReturnLowerer, opts?: ExprOpts): string {
    switch (stmt.kind) {
        case "return":
            return ret(stmt.value, indent);
        case "if": {
            const cond = exprToCpp(stmt.condition, opts);
            const then = stmt.consequent.map((s) => stmtToCpp(s, indent + "    ", ret, opts)).join("\n");
            let out = `${indent}if (${cond}) {\n${then}\n${indent}}`;
            if (stmt.alternate && stmt.alternate.length > 0) {
                const alt = stmt.alternate.map((s) => stmtToCpp(s, indent + "    ", ret, opts)).join("\n");
                out += ` else {\n${alt}\n${indent}}`;
            }
            return out;
        }
        case "const":
            return `${indent}auto ${stmt.name} = ${exprToCpp(stmt.init, opts)};`;
        case "expression":
            return `${indent}${exprToCpp(stmt.expr, opts)};`;
        case "assign":
            return `${indent}${exprToCpp(stmt.target, opts)} = ${exprToCpp(stmt.value, opts)};`;
    }
}

/**
 * Rewrite portable cross-field access `<ctx>.object.<field>` to a Value lookup
 * `<ctx>.object.at("<field>")` (returns a const Value&; missing keys read as null).
 * No-op when the body declares no context parameter.
 */
export function rewriteContextAccess(code: string, ctxParam: string | undefined): string {
    if (ctxParam === undefined) return code;
    const re = new RegExp(`\\b${ctxParam}\\.object\\.([A-Za-z_][A-Za-z0-9_]*)`, "g");
    return code.replace(re, `${ctxParam}.object.at("$1")`);
}

// ─── Validators (validators.hpp) ──────────────────────────────────────────────

export function emitValidatorsCpp(
    decls: readonly IRValidatorDeclaration[],
    hasFunctions: boolean,
    nsRoot: string,
    runtimeInclude: string,
): string {
    const lines = [
        "#pragma once",
        `#include ${runtimeInclude}`,
        ...(hasFunctions ? [`#include "functions.hpp"`] : []),
        "",
        `namespace ${nsRoot}::validators {`,
        ...(hasFunctions ? ["", `using namespace ${nsRoot}::functions;`] : []),
        "",
    ];
    for (const d of decls) lines.push(emitValidatorFactory(d), "");
    lines.push(`}  // namespace ${nsRoot}::validators`, "");
    return lines.join("\n");
}

function emitValidatorFactory(decl: IRValidatorDeclaration): string {
    const factoryParams = decl.factoryParams.map(cppFactoryParam).join(", ");
    const captures = decl.factoryParams.map((p) => p.name).join(", ");
    const valueParam = decl.body.params.find((p) => p.role === "value")?.name ?? "__value";
    const ctxParam = decl.body.params.find((p) => p.role === "context")?.name;
    const fieldName = decl.body.params.find((p) => p.role === "field")?.name ?? "__field";
    const ctxName = ctxParam ?? "__ctx";
    const binding = valueBinding(decl.inputType, "__raw");
    const guard = irTypeGuard(decl.inputType, "__raw");

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
        const label = JSON.stringify(`expected ${irTypeLabel(decl.inputType)}`);
        lines.push(
            `        if (!(${guard})) return ${E}(std::unexpected(keyma::ValidationError{` +
            `std::pmr::string(${fieldName}, __raw.get_allocator()), ` +
            `std::pmr::string("type_error", __raw.get_allocator()), ` +
            `std::pmr::string(${label}, __raw.get_allocator())}));`,
        );
    }
    lines.push(`        [[maybe_unused]] ${binding.cppType} ${valueParam} = ${binding.init};`);
    for (const stmt of decl.body.statements) lines.push(stmtToCpp(stmt, "        ", ret));
    lines.push(`    }};`, `}`);
    return rewriteContextAccess(lines.join("\n"), ctxParam);
}

// ─── Formatters (formatters.hpp) ──────────────────────────────────────────────

export function emitFormattersCpp(
    decls: readonly IRFormatterDeclaration[],
    hasFunctions: boolean,
    nsRoot: string,
    runtimeInclude: string,
): string {
    const lines = [
        "#pragma once",
        `#include ${runtimeInclude}`,
        "#include <stdexcept>",
        ...(hasFunctions ? [`#include "functions.hpp"`] : []),
        "",
        `namespace ${nsRoot}::formatters {`,
        ...(hasFunctions ? ["", `using namespace ${nsRoot}::functions;`] : []),
        "",
    ];
    for (const d of decls) lines.push(emitFormatterFactory(d), "");
    lines.push(`}  // namespace ${nsRoot}::formatters`, "");
    return lines.join("\n");
}

function emitFormatterFactory(decl: IRFormatterDeclaration): string {
    const factoryParams = decl.factoryParams.map(cppFactoryParam).join(", ");
    const captures = decl.factoryParams.map((p) => p.name).join(", ");
    const valueParam = decl.body.params.find((p) => p.role === "value")?.name ?? "__value";
    const ctxParam = decl.body.params.find((p) => p.role === "context")?.name;
    const ctxName = ctxParam ?? "__ctx";
    const binding = valueBinding(decl.inputType, "__raw");
    const guard = irTypeGuard(decl.inputType, "__raw");

    const ret: ReturnLowerer = (value, indent) =>
        value === null
            ? `${indent}return keyma::Value{};`
            : `${indent}return keyma::to_value(${exprToCpp(value)}, __raw.get_allocator());`;

    const lines: string[] = [
        `inline keyma::FormatterFn ${factoryIdent(decl.name)}(${factoryParams}) {`,
        `    return keyma::FormatterFn{[${captures}](const keyma::Value& __raw, [[maybe_unused]] const keyma::Context& ${ctxName}) -> keyma::Value {`,
    ];
    if (guard !== null) {
        const msg = JSON.stringify(`${decl.name} formatter expected ${irTypeLabel(decl.inputType)}`);
        lines.push(`        if (!(${guard})) throw std::runtime_error(${msg});`);
    }
    lines.push(`        [[maybe_unused]] ${binding.cppType} ${valueParam} = ${binding.init};`);
    for (const stmt of decl.body.statements) lines.push(stmtToCpp(stmt, "        ", ret));
    lines.push(`    }};`, `}`);
    return rewriteContextAccess(lines.join("\n"), ctxParam);
}

// ─── Utility functions (functions.hpp) ────────────────────────────────────────

export function emitFunctionsCpp(decls: readonly IRFunctionDeclaration[], nsRoot: string, runtimeInclude: string): string {
    const lines = ["#pragma once", `#include ${runtimeInclude}`, "", `namespace ${nsRoot}::functions {`, ""];
    for (const decl of decls) {
        const params = decl.params.map((p) => `${irTypeToCpp(p.type)} ${p.name}`).join(", ");
        lines.push(`inline auto ${decl.name}(${params}) {`);
        for (const stmt of decl.statements) lines.push(stmtToCpp(stmt, "    ", plainReturn));
        lines.push(`}`, "");
    }
    lines.push(`}  // namespace ${nsRoot}::functions`, "");
    return lines.join("\n");
}

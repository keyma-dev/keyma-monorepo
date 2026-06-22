import type { IRExpression } from "@keyma/ir";

/**
 * Controls how `field` nodes (`this.x`) lower. Default (typed mode) emits `this->x`
 * for computed getters / methods that operate on typed struct members. The
 * defaults/materializer emitters pass a record-oriented accessor instead. `isRefField`
 * marks reference-typed fields, whose members are reached through a `std::shared_ptr`
 * (so `author.id` lowers to `this->author->id`).
 */
export type ExprOpts = { fieldExpr: (name: string) => string; isRefField?: (name: string) => boolean };

const TYPED: ExprOpts = { fieldExpr: (n) => `this->${n}` };

/** Lower an IRExpression to a C++23 source string. */
export function exprToCpp(expr: IRExpression, opts: ExprOpts = TYPED): string {
    switch (expr.kind) {
        case "literal":
            if (expr.value === true) return "true";
            if (expr.value === false) return "false";
            if (expr.value === null) return "nullptr";
            return typeof expr.value === "string" ? cppStr(expr.value) : String(expr.value);

        case "field":
            return opts.fieldExpr(expr.name);

        case "identifier":
            return expr.name === "undefined" ? "nullptr" : expr.name;

        case "member": {
            const refMember = expr.object.kind === "field" && opts.isRefField?.(expr.object.name) === true;
            return `${wrapIfComplex(expr.object, opts)}${refMember ? "->" : "."}${expr.member}`;
        }

        case "template":
            return templateToCpp(expr.parts, opts);

        case "unary": {
            const op = expr.op === "!" ? "!" : expr.op;
            return `${op}${wrapIfComplex(expr.operand, opts)}`;
        }

        case "binary": {
            if (expr.op === "&&") return `${wrapIfBinaryChild(expr.left, opts)} && ${wrapIfBinaryChild(expr.right, opts)}`;
            if (expr.op === "||") return `${wrapIfBinaryChild(expr.left, opts)} || ${wrapIfBinaryChild(expr.right, opts)}`;
            if (expr.op === "??") return `keyma::coalesce(${exprToCpp(expr.left, opts)}, ${exprToCpp(expr.right, opts)})`;
            // C++ `%` is integer-only; route JS modulo through keyma::mod (fmod for floats).
            if (expr.op === "%") return `keyma::mod(${exprToCpp(expr.left, opts)}, ${exprToCpp(expr.right, opts)})`;
            return `${wrapIfBinaryChild(expr.left, opts)} ${expr.op} ${wrapIfBinaryChild(expr.right, opts)}`;
        }

        case "conditional":
            return `(${wrapIfComplex(expr.condition, opts)} ? ${wrapIfComplex(expr.whenTrue, opts)} : ${exprToCpp(expr.whenFalse, opts)})`;

        case "call": {
            const callee = wrapIfComplex(expr.callee, opts);
            const args = expr.args.map((a) => exprToCpp(a, opts)).join(", ");
            return `${callee}(${args})`;
        }

        case "typeof":
            return `keyma::js_typeof(${exprToCpp(expr.operand, opts)})`;

        case "object":
            return objectToCpp(expr.properties, opts);

        case "regexp":
            return `keyma::make_regex(${cppStr(expr.pattern)}, ${cppStr(expr.flags)})`;

        case "arrow":
            return `[&](${expr.params.map((p) => `auto ${p}`).join(", ")}) { return ${exprToCpp(expr.body, opts)}; }`;

        case "new": {
            if (expr.callee.kind === "identifier" && expr.callee.name === "RegExp") return regexpNewToCpp(expr.args, opts);
            if (expr.callee.kind === "identifier" && expr.callee.name === "Date") return dateNewToCpp(expr.args, opts);
            const callee = wrapIfComplex(expr.callee, opts);
            return `${callee}(${expr.args.map((a) => exprToCpp(a, opts)).join(", ")})`;
        }

        case "intrinsic":
            return intrinsicToCpp(expr, opts);
    }
}

/**
 * Translate a canonical intrinsic op to a `keyma::` helper call (overloaded so the
 * receiver may be a typed value or a Value). This is the C++ backend's implementation
 * of the shared intrinsic registry (packages/ir/intrinsics.md); every `required` op
 * is handled.
 */
function intrinsicToCpp(expr: Extract<IRExpression, { kind: "intrinsic" }>, opts: ExprOpts): string {
    const recv = expr.receiver !== null ? exprToCpp(expr.receiver, opts) : "";
    const args = expr.args.map((a) => exprToCpp(a, opts));
    const arg0 = args[0];

    switch (expr.op) {
        case "string.includes":
        case "array.includes":
            return `keyma::includes(${recv}, ${arg0})`;
        case "string.startsWith":
            return `keyma::starts_with(${recv}, ${arg0})`;
        case "string.endsWith":
            return `keyma::ends_with(${recv}, ${arg0})`;
        case "string.toLowerCase":
            return `keyma::to_lower(${recv})`;
        case "string.toUpperCase":
            return `keyma::to_upper(${recv})`;
        case "string.trim":
            return `keyma::trim(${recv})`;
        case "string.length":
        case "array.length":
            return `keyma::length(${recv})`;
        case "string.indexOf":
        case "array.indexOf":
            return `keyma::index_of(${recv}, ${arg0})`;
        case "string.slice":
            return args.length >= 2 ? `keyma::slice(${recv}, ${arg0}, ${args[1]})` : `keyma::slice(${recv}, ${arg0})`;
        case "string.charAt":
            return `keyma::char_at(${recv}, ${arg0})`;
        case "string.replace":
            return `keyma::replace(${recv}, ${arg0}, ${args[1] ?? '""'})`;
        case "array.join":
            return `keyma::join(${recv}, ${arg0 ?? '","'})`;
        case "array.filter":
            return `keyma::filter(${recv}, ${arg0})`;
        case "regexp.test":
            return `keyma::regex_test(${recv}, ${arg0})`;
        case "date.getTime":
            return `keyma::date_get_time(${recv})`;
        case "date.getFullYear":
            return `keyma::date_year(${recv})`;
        case "date.getMonth":
            return `keyma::date_month0(${recv})`;
        case "date.getDate":
            return `keyma::date_day(${recv})`;
        case "date.getDay":
            return `keyma::date_weekday(${recv})`;
        case "date.getHours":
            return `keyma::date_hours(${recv})`;
        case "date.getMinutes":
            return `keyma::date_minutes(${recv})`;
        case "date.getSeconds":
            return `keyma::date_seconds(${recv})`;
        case "date.getMilliseconds":
            return `keyma::date_milliseconds(${recv})`;
        case "date.toISOString":
            return `keyma::to_iso8601(${recv})`;
        case "date.now":
            return `keyma::date_get_time(keyma::date_now())`;
        case "type-is":
            return `keyma::type_is(${recv}, ${cppStr(literalText(expr.args[0]))})`;
        case "instance-of":
            return `keyma::instance_of(${recv}, ${cppStr(literalText(expr.args[0]))})`;
        default:
            // Every registry op is handled above; an unknown op surfaces as an
            // undeclared call naming the op, failing the build loudly.
            return `keyma::unsupported_intrinsic_${expr.op.replace(/[^A-Za-z0-9_]/g, "_")}()`;
    }
}

/** `new RegExp(pattern[, flags])` → keyma::make_regex(...). */
function regexpNewToCpp(args: IRExpression[], opts: ExprOpts): string {
    const pat = args[0] !== undefined ? exprToCpp(args[0], opts) : '""';
    const flags = args[1] !== undefined ? exprToCpp(args[1], opts) : '""';
    return `keyma::make_regex(${pat}, ${flags})`;
}

/**
 * `new Date(...)` → a keyma::DateTime. `new Date()` → now; component form (month is
 * JS 0-based, so +1 is applied in date_from_components); a string → ISO parse; a
 * number → epoch ms. A dynamic single argument is assumed to be epoch ms.
 */
function dateNewToCpp(args: IRExpression[], opts: ExprOpts): string {
    if (args.length === 0) return "keyma::date_now()";
    if (args.length >= 2) {
        const parts = args.map((a) => exprToCpp(a, opts));
        return `keyma::date_from_components(${parts.join(", ")})`;
    }
    const arg = args[0]!;
    if (arg.kind === "literal" && typeof arg.value === "string") return `keyma::date_parse(${cppStr(arg.value)})`;
    if (arg.kind === "literal" && typeof arg.value === "number") return `keyma::date_from_epoch_ms(${arg.value})`;
    return `keyma::date_from_epoch_ms(${exprToCpp(arg, opts)})`;
}

/** Build a keyma::Value object literal via an immediately-invoked lambda. */
function objectToCpp(properties: ReadonlyArray<{ key: string; value: IRExpression }>, opts: ExprOpts): string {
    const sets = properties
        .map((p) => `__o.set(${cppStr(p.key)}, keyma::to_value(${exprToCpp(p.value, opts)}, __a));`)
        .join(" ");
    return `[&](keyma::alloc_t __a) { auto __o = keyma::Value::object(__a); ${sets} return __o; }({})`;
}

/** A C++ string literal for a JS string (JSON's escaping is valid for C++). */
function cppStr(s: string): string {
    return JSON.stringify(s);
}

/** Read a string-literal arg's value (type/constructor name), or "" if not a literal. */
function literalText(expr: IRExpression | undefined): string {
    return expr !== undefined && expr.kind === "literal" && typeof expr.value === "string" ? expr.value : "";
}

/** Wrap in parens if grouping is needed in certain positions. */
function wrapIfComplex(expr: IRExpression, opts: ExprOpts): string {
    const s = exprToCpp(expr, opts);
    if (expr.kind === "binary" || expr.kind === "conditional" || expr.kind === "typeof" || expr.kind === "arrow") {
        return `(${s})`;
    }
    return s;
}

/** Wrap binary/conditional children in parens to preserve precedence/associativity. */
function wrapIfBinaryChild(expr: IRExpression, opts: ExprOpts): string {
    const s = exprToCpp(expr, opts);
    if (expr.kind === "binary" || expr.kind === "conditional") return `(${s})`;
    return s;
}

/**
 * Render a template literal via std::format: literal parts fold into the format
 * string (braces doubled); interpolations become `{}` placeholders. With no
 * interpolations it is just a string literal.
 */
function templateToCpp(parts: IRExpression[], opts: ExprOpts): string {
    if (parts.length === 0) return '""';
    let fmt = "";
    const args: string[] = [];
    for (const p of parts) {
        if (p.kind === "literal") {
            fmt += String(p.value === null ? "null" : p.value).replace(/[{}]/g, (m) => m + m);
        } else {
            fmt += "{}";
            args.push(exprToCpp(p, opts));
        }
    }
    if (args.length === 0) return cppStr(fmt);
    return `std::format(${cppStr(fmt)}, ${args.join(", ")})`;
}

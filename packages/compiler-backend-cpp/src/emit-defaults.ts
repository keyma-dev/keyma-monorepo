import type { IRSchema, IRDefault, IRExpression } from "@keyma/ir";
import { filterVisibleFields } from "@keyma/compiler-util";
import { exprToCpp, type ExprOpts } from "./emit-expression.js";
import { factoryIdent } from "./emit-validators.js";

/**
 * Build a free function applying a schema's field defaults (literal AND expression)
 * to a record `keyma::Value`, referenced from the schema metadata (server bundles
 * only). A default is applied only when the field is currently null/absent. Field
 * references inside an expression default lower to `value.at("x")`. Returns the
 * function name + source, or null when there are no applicable defaults.
 */
export function buildApplyDefaults(schema: IRSchema, includePrivate: boolean): { name: string; def: string } | null {
    const valueOpts: ExprOpts = { fieldExpr: (n: string) => `value.at(${JSON.stringify(n)})` };
    const body: string[] = [];
    for (const f of filterVisibleFields(schema, includePrivate)) {
        if (f.default === undefined) continue;
        const valExpr = defaultValueExpr(f.default, valueOpts);
        if (valExpr === null) continue;
        body.push(`    if (value.at(${JSON.stringify(f.name)}).is_null()) {`);
        body.push(`        value.set(${JSON.stringify(f.name)}, ${valExpr});`);
        body.push(`    }`);
    }
    if (body.length === 0) return null;

    const name = `apply_defaults_${factoryIdent(schema.sourceName)}`;
    const lines = [`inline void ${name}(keyma::Value& value, const keyma::Value::allocator_type& __a) {`, ...body, `}`];
    return { name, def: lines.join("\n") };
}

/**
 * The `keyma::Value` expression for a field default, or null when there is nothing to
 * apply: a `null` literal (the field is already null) or an array literal (the Value
 * API has no array builder yet — array literal defaults are a documented gap).
 */
function defaultValueExpr(def: IRDefault, valueOpts: ExprOpts): string | null {
    if (def.kind === "expression") {
        return `keyma::to_value(${exprToCpp(def.expression, valueOpts)}, __a)`;
    }
    const v = def.value;
    if (v === null || Array.isArray(v)) return null;
    const lit: IRExpression = { kind: "literal", value: v };
    return `keyma::to_value(${exprToCpp(lit, valueOpts)}, __a)`;
}

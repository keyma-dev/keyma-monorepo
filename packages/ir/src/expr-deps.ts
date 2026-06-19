import type { IRExpression } from "./types.js";

/**
 * Collect the names of every `{ kind: "field" }` reference in an expression tree.
 * Identifiers bound by an `arrow`'s parameters are shadow bindings, not field
 * references, and are excluded. The result preserves first-seen order and is
 * de-duplicated. Used to compute computed-field dependencies for cycle detection
 * and materialization ordering.
 */
export function collectFieldRefs(expr: IRExpression): string[] {
    const out: string[] = [];
    const seen = new Set<string>();

    const add = (name: string): void => {
        if (!seen.has(name)) {
            seen.add(name);
            out.push(name);
        }
    };

    const walk = (e: IRExpression, shadowed: ReadonlySet<string>): void => {
        switch (e.kind) {
            case "field":
                if (!shadowed.has(e.name)) add(e.name);
                return;
            case "literal":
            case "identifier":
            case "regexp":
                return;
            case "member":
                walk(e.object, shadowed);
                return;
            case "call":
                walk(e.callee, shadowed);
                for (const a of e.args) walk(a, shadowed);
                return;
            case "new":
                walk(e.callee, shadowed);
                for (const a of e.args) walk(a, shadowed);
                return;
            case "typeof":
                walk(e.operand, shadowed);
                return;
            case "template":
                for (const p of e.parts) walk(p, shadowed);
                return;
            case "binary":
                walk(e.left, shadowed);
                walk(e.right, shadowed);
                return;
            case "unary":
                walk(e.operand, shadowed);
                return;
            case "conditional":
                walk(e.condition, shadowed);
                walk(e.whenTrue, shadowed);
                walk(e.whenFalse, shadowed);
                return;
            case "object":
                for (const p of e.properties) walk(p.value, shadowed);
                return;
            case "arrow": {
                const inner = new Set(shadowed);
                for (const p of e.params) inner.add(p);
                walk(e.body, inner);
                return;
            }
            case "intrinsic":
                if (e.receiver !== null) walk(e.receiver, shadowed);
                for (const a of e.args) walk(a, shadowed);
                return;
        }
    };

    walk(expr, new Set());
    return out;
}

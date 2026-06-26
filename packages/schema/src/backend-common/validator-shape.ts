import type { IRFunctionDeclaration, IRArrowParam, IRType, IRStatement } from "@keyma/core/ir";

/**
 * The validator/formatter factory shape recovered from a collapsed `IRFunctionDeclaration`.
 *
 * After the validator→function collapse, a factory is an ordinary function whose body
 * `return`s a typed inner arrow: `function f(spec) { return (value, field, ctx) => … }`.
 * The schema backend packs reconstruct the runtime `ValidatorFn`/`FormatterFn` wrapper from
 * that shape — the factory params (with `optional?`), the inner arrow's positional params
 * (value / field / context), the input type (the inner arrow's first param type, formerly
 * `inputType`), and the inner body statements.
 */
export type ValidatorShape = {
    /** Outer factory params; names become spec keys, `optional` lets typed backends default them. */
    factoryParams: { name: string; optional?: boolean }[];
    /** Inner-arrow positional params, in source order (value[, field[, context]]). */
    innerParams: string[];
    /** The value param name (inner position 0). */
    valueParam: string;
    /** The field-key param name (inner position 1), if present. */
    fieldParam: string | undefined;
    /** The context param name (inner position 2), if present. */
    ctxParam: string | undefined;
    /** Declared value type — backends emit a runtime type guard / binding from it. */
    inputType: IRType;
    /** The inner function body, as portable statements. */
    statements: IRStatement[];
};

const arrowParamName = (p: IRArrowParam | undefined): string | undefined =>
    p === undefined ? undefined : typeof p === "string" ? p : p.name;

/**
 * Recover the validator/formatter shape from a collapsed factory function declaration. The
 * frontend lowering guarantees the body is a single `return <arrow>`; a malformed/empty
 * factory (lowering already reported a diagnostic) yields an empty shape.
 */
export function validatorShape(decl: IRFunctionDeclaration): ValidatorShape {
    const factoryParams = decl.params.map((p) => ({
        name: p.name,
        ...(p.optional === true ? { optional: true } : {}),
    }));

    const ret = decl.statements[0];
    const arrow =
        ret !== undefined && ret.kind === "return" && ret.value !== null && ret.value.kind === "arrow"
            ? ret.value
            : undefined;

    const params = arrow?.params ?? [];
    const innerParams = params.map((p, i) => arrowParamName(p) ?? `_p${i}`);
    const first = params[0];
    const inputType: IRType =
        first !== undefined && typeof first !== "string" && first.type !== undefined
            ? first.type
            : { kind: "json" };

    const statements: IRStatement[] =
        arrow?.statements ?? (arrow?.body !== undefined ? [{ kind: "return", value: arrow.body }] : []);

    return {
        factoryParams,
        innerParams,
        valueParam: innerParams[0] ?? "__value",
        fieldParam: innerParams[1],
        ctxParam: innerParams[2],
        inputType,
        statements,
    };
}

/** The validator/formatter factory names referenced by any field's `extensions['schema']`. */
export function referencedFactoryNames(
    validatorNames: Iterable<string>,
    formatterNames: Iterable<string>,
): ReadonlySet<string> {
    const out = new Set<string>();
    for (const n of validatorNames) out.add(n);
    for (const n of formatterNames) out.add(n);
    return out;
}

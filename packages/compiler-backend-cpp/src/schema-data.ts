import type { IRSchema, IRField, IRValidatorDeclaration, IRFormatterDeclaration } from "@keyma/ir";
import { typeTag } from "./ir-type-to-cpp.js";
import { buildFactoryCall, factoryIdent } from "./emit-validators.js";

export type SchemaDataOptions = {
    includePrivate: boolean;
    includeIndexes: boolean;
    formPhasesOnly: boolean;
    validatorDecls: ReadonlyMap<string, IRValidatorDeclaration>;
    formatterDecls: ReadonlyMap<string, IRFormatterDeclaration>;
    /** Embedded/reference targets: the target's `name` paired with its fully-qualified C++ struct. */
    refs: readonly { name: string; cppClass: string }[];
    /** Unqualified name of the apply_defaults free function to reference, if any. */
    applyDefaultsName?: string;
    /** Root namespace (validators/formatters live under `<root>::validators` etc.). */
    nsRoot: string;
};

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);
const PHASE: Record<string, string> = { change: "Change", blur: "Blur", submit: "Submit", save: "Save" };

/**
 * Build the body of a schema's `schema()` accessor — function-local static arrays for
 * per-field validators/formatters, schema indexes, and refs, then the SchemaMeta and a
 * reference return. Designed to be wrapped by emit-module in an out-of-line inline
 * definition once all structs in the module are complete.
 */
export function buildSchemaMeta(schema: IRSchema, opts: SchemaDataOptions): string {
    const fields = visibleFields(schema, opts.includePrivate);
    const out: string[] = [];
    const I = "    ";

    // Per-field validator / formatter arrays.
    for (const f of fields) {
        if (f.validators.length > 0) {
            const calls = f.validators.map((v) =>
                buildFactoryCall(v.name, v.params, opts.validatorDecls.get(v.name)?.factoryParams ?? [], `${opts.nsRoot}::validators`),
            );
            out.push(`${I}static const keyma::ValidatorFn __v_${f.name}[] = { ${calls.join(", ")} };`);
        }
        const formatters = opts.formPhasesOnly ? f.formatters.filter((fm) => CLIENT_PHASES.has(fm.phase)) : f.formatters;
        if (formatters.length > 0) {
            const items = formatters.map((fm) => {
                const call = buildFactoryCall(
                    fm.spec.name, fm.spec.params, opts.formatterDecls.get(fm.spec.name)?.factoryParams ?? [], `${opts.nsRoot}::formatters`,
                );
                return `{ keyma::Phase::${PHASE[fm.phase]}, ${call} }`;
            });
            out.push(`${I}static const keyma::PhasedFormatter __f_${f.name}[] = { ${items.join(", ")} };`);
        }
    }

    // Schema-level indexes (server bundles only).
    const indexes = opts.includeIndexes ? schema.indexes : [];
    indexes.forEach((idx, n) => {
        const names = idx.fields.map((fld) => JSON.stringify(fld.name)).join(", ");
        out.push(`${I}static const std::string_view __idxf_${n}[] = { ${names} };`);
    });
    if (indexes.length > 0) {
        const items = indexes.map((idx, n) => `{ std::span<const std::string_view>{__idxf_${n}}, ${idx.unique === true} }`);
        out.push(`${I}static const keyma::IndexMeta __idx[] = { ${items.join(", ")} };`);
    }

    // refs map (embedded/reference targets → their metadata accessor).
    if (opts.refs.length > 0) {
        const entries = opts.refs.map((r) => `{ ${JSON.stringify(r.name)}, &${r.cppClass}::schema }`);
        out.push(`${I}static const std::pair<std::string_view, const keyma::SchemaMeta& (*)()> __refs[] = { ${entries.join(", ")} };`);
    }

    // Field metadata array.
    const fieldInits = fields.map((f) => buildFieldMeta(f, opts));
    out.push(`${I}static const keyma::FieldMeta __fields[] = {`);
    for (const fi of fieldInits) out.push(`${I}${I}${fi},`);
    out.push(`${I}};`);

    // The SchemaMeta aggregate (designated initializers; defaults omitted).
    const meta: string[] = [
        `.name = ${JSON.stringify(schema.name)}`,
        `.source_name = ${JSON.stringify(schema.sourceName)}`,
    ];
    if (schema.visibility === "private") meta.push(`.visibility = keyma::Visibility::Private`);
    if (schema.ephemeral) meta.push(`.ephemeral = true`);
    meta.push(`.fields = std::span<const keyma::FieldMeta>{__fields}`);
    if (indexes.length > 0) meta.push(`.indexes = std::span<const keyma::IndexMeta>{__idx}`);
    if (opts.refs.length > 0) meta.push(`.refs = std::span<const std::pair<std::string_view, const keyma::SchemaMeta& (*)()>>{__refs}`);
    if (opts.applyDefaultsName !== undefined) meta.push(`.apply_defaults = &${opts.applyDefaultsName}`);

    out.push(`${I}static const keyma::SchemaMeta __meta{ ${meta.join(", ")} };`);
    out.push(`${I}return __meta;`);
    return out.join("\n");
}

function buildFieldMeta(field: IRField, opts: SchemaDataOptions): string {
    const parts: string[] = [`.name = ${JSON.stringify(field.name)}`, `.type = ${typeTag(field.type)}`];
    if (!field.required) parts.push(`.required = false`);
    if (field.nullable === true) parts.push(`.nullable = true`);
    if (field.readonly) parts.push(`.readonly = true`);
    if (field.computed !== undefined) parts.push(`.computed = true`);
    if (opts.includeIndexes && field.indexes.length > 0) parts.push(`.indexed = true`);
    if (field.visibility === "private") parts.push(`.visibility = keyma::Visibility::Private`);
    if (field.validators.length > 0) parts.push(`.validators = std::span<const keyma::ValidatorFn>{__v_${field.name}}`);
    const formatters = opts.formPhasesOnly ? field.formatters.filter((fm) => CLIENT_PHASES.has(fm.phase)) : field.formatters;
    if (formatters.length > 0) parts.push(`.formatters = std::span<const keyma::PhasedFormatter>{__f_${field.name}}`);
    return `keyma::FieldMeta{ ${parts.join(", ")} }`;
}

/**
 * Build the materializer for a schema's computed fields (server bundles only). It
 * constructs the typed model from the record, evaluates each computed getter, and
 * writes the results back into the record Value. Returns null when there are none.
 */
export function buildMaterializer(schema: IRSchema, includePrivate: boolean): string | null {
    const computed = visibleFields(schema, includePrivate).filter((f) => f.computed !== undefined);
    if (computed.length === 0) return null;
    const lines = [
        `inline void materialize_${factoryIdent(schema.sourceName)}(keyma::Value& value) {`,
        `    auto __a = value.get_allocator();`,
        `    ${schema.sourceName} __m = ${schema.sourceName}::from_value(value, __a);`,
    ];
    for (const f of computed) {
        lines.push(`    value.set(${JSON.stringify(f.name)}, keyma::to_value(__m.${f.name}(), __a));`);
    }
    lines.push(`}`);
    return lines.join("\n");
}

export function hasComputedFields(schema: IRSchema, includePrivate: boolean): boolean {
    return visibleFields(schema, includePrivate).some((f) => f.computed !== undefined);
}

function visibleFields(schema: IRSchema, includePrivate: boolean): IRField[] {
    return includePrivate ? schema.fields : schema.fields.filter((f) => f.visibility === "public");
}

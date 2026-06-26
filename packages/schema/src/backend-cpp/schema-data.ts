import type { IRClassDeclaration, IRField } from "@keyma/core/ir";
import { filterVisibleFields } from "@keyma/core/util";
import { typeTag, type SchemaDataOptions } from "@keyma/compiler/backend-cpp";
import { buildFactoryCall } from "./emit-validators.js";
import { schemaIndexes, schemaEphemeral, fieldIndexes, fieldValidators, fieldFormatters } from "../ir/extensions.js";

export type { SchemaDataOptions };

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);
const PHASE: Record<string, string> = { change: "Change", blur: "Blur", submit: "Submit", save: "Save" };

/**
 * Build the body of a schema's `schema()` accessor — function-local static arrays for
 * per-field validators/formatters, schema indexes, and refs, then the SchemaMeta and a
 * reference return. Designed to be wrapped by emit-module in an out-of-line inline
 * definition once all structs in the module are complete.
 */
export function buildSchemaMeta(schema: IRClassDeclaration, opts: SchemaDataOptions): string {
    const fields = filterVisibleFields(schema, opts.includePrivate);
    const out: string[] = [];
    const I = "    ";

    // Per-field validator / formatter arrays.
    for (const f of fields) {
        const validators = fieldValidators(f);
        if (validators.length > 0) {
            const calls = validators.map((v) =>
                buildFactoryCall(v.name, v.params, opts.functionDecls.get(v.name)?.params ?? [], `${opts.nsRoot}::validators`),
            );
            out.push(`${I}static const keyma::ValidatorFn __v_${f.name}[] = { ${calls.join(", ")} };`);
        }
        const allFormatters = fieldFormatters(f);
        const formatters = opts.formPhasesOnly ? allFormatters.filter((fm) => CLIENT_PHASES.has(fm.phase)) : allFormatters;
        if (formatters.length > 0) {
            const items = formatters.map((fm) => {
                const call = buildFactoryCall(
                    fm.spec.name, fm.spec.params, opts.functionDecls.get(fm.spec.name)?.params ?? [], `${opts.nsRoot}::formatters`,
                );
                return `{ keyma::Phase::${PHASE[fm.phase]}, ${call} }`;
            });
            out.push(`${I}static const keyma::PhasedFormatter __f_${f.name}[] = { ${items.join(", ")} };`);
        }
    }

    // Schema-level indexes (server bundles only).
    const indexes = opts.includeIndexes ? schemaIndexes(schema) : [];
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
    if (schemaEphemeral(schema)) meta.push(`.ephemeral = true`);
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
    if (opts.includeIndexes && fieldIndexes(field).length > 0) parts.push(`.indexed = true`);
    if (field.visibility === "private") parts.push(`.visibility = keyma::Visibility::Private`);
    // Nested-type wire detail (consumed by serialize.hpp and the binary codec). For an array
    // the element carries the relevant bits/unsigned/target/idType (TypeInfo::element_of), so
    // resolve the "core" type first. `.element`/`.target` precede validators in declaration
    // order; `.bits`/`.is_unsigned`/`.id_type`/`.id_unsigned` trail `.tag`.
    const core = field.type.kind === "array" ? field.type.of : field.type;
    if (field.type.kind === "array") parts.push(`.element = ${typeTag(core)}`);
    if (core.kind === "embedded" || core.kind === "reference") parts.push(`.target = ${JSON.stringify(core.schema)}`);
    if (fieldValidators(field).length > 0) parts.push(`.validators = std::span<const keyma::ValidatorFn>{__v_${field.name}}`);
    const allFormatters = fieldFormatters(field);
    const formatters = opts.formPhasesOnly ? allFormatters.filter((fm) => CLIENT_PHASES.has(fm.phase)) : allFormatters;
    if (formatters.length > 0) parts.push(`.formatters = std::span<const keyma::PhasedFormatter>{__f_${field.name}}`);
    // Stable binary wire tag (present only when binary serialization is enabled). Trailing
    // defaulted member, so this stays in declaration order after `.formatters`.
    if (field.tag !== undefined) parts.push(`.tag = ${field.tag}`);
    // Binary-wire scalar detail: float32 vs float64, plain vs zigzag ints, and the bare-id
    // wire kind of a reference. Defaults (bits 64, signed, id_type Id ⇒ length) are omitted.
    if (core.kind === "number" && core.bits === 32) parts.push(`.bits = 32`);
    if (core.kind === "integer" && core.unsigned === true) parts.push(`.is_unsigned = true`);
    if (core.kind === "reference" && core.idType !== undefined) {
        const idTag = typeTag(core.idType);
        if (idTag !== "keyma::TypeTag::Id") parts.push(`.id_type = ${idTag}`);
        if (core.idType.kind === "integer" && core.idType.unsigned === true) parts.push(`.id_unsigned = true`);
    }
    return `keyma::FieldMeta{ ${parts.join(", ")} }`;
}

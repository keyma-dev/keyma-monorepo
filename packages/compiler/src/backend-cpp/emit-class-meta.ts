import type { CppClassData, CppFieldData } from "./emitter-registry.js";
import { typeTag } from "./ir-type-to-cpp.js";

/**
 * Render a class's `keyma::ClassMetadata` accessor body from the neutral {@link CppClassData}
 * a domain pack produces. The generic C++ backend owns all of this language syntax — the
 * function-local static backing arrays for the per-field validators/formatters, the class
 * indexes and refs, the `FieldMeta` array, and the final `ClassMetadata` aggregate — while the
 * domain contributes only data (which fields ride, their validator/formatter factory calls,
 * the ref targets, indexes, etc.). Mirrors the JS/Python `buildClassData` → `emitLiteral`
 * split, but the C++ aggregate is span-backed, so the layout lives in a purpose-built renderer
 * rather than a generic literal walker.
 *
 * The metadata's camelCase identity (`source_name`, `apply_defaults`, …) and the `FieldMeta`
 * member order are the runtime contract; this renderer is the sole owner of both.
 */

const PHASE: Record<string, string> = { change: "Change", blur: "Blur", submit: "Submit", save: "Save" };
const I = "    ";

export function emitClassMeta(data: CppClassData): string {
    const out: string[] = [];

    // Per-field validator / formatter arrays (the factory calls are the domain's only C++).
    for (const f of data.fields) {
        if (f.validators !== undefined && f.validators.length > 0) {
            out.push(`${I}static const keyma::ValidatorFn __v_${f.name}[] = { ${f.validators.join(", ")} };`);
        }
        if (f.formatters !== undefined && f.formatters.length > 0) {
            const items = f.formatters.map((fm) => `{ keyma::Phase::${PHASE[fm.phase]}, ${fm.fn} }`);
            out.push(`${I}static const keyma::PhasedFormatter __f_${f.name}[] = { ${items.join(", ")} };`);
        }
    }

    // Class-level indexes (server bundles only — already gated by the domain).
    data.indexes.forEach((idx, n) => {
        const names = idx.fields.map((fld) => JSON.stringify(fld)).join(", ");
        out.push(`${I}static const std::string_view __idxf_${n}[] = { ${names} };`);
    });
    if (data.indexes.length > 0) {
        const items = data.indexes.map((idx, n) => `{ std::span<const std::string_view>{__idxf_${n}}, ${idx.unique} }`);
        out.push(`${I}static const keyma::IndexMeta __idx[] = { ${items.join(", ")} };`);
    }

    // refs map (embedded/reference targets → their metadata accessor).
    if (data.refs.length > 0) {
        const entries = data.refs.map((r) => `{ ${JSON.stringify(r.name)}, &${r.cppClass}::metadata }`);
        out.push(`${I}static const std::pair<std::string_view, const keyma::ClassMetadata& (*)()> __refs[] = { ${entries.join(", ")} };`);
    }

    // Field metadata array.
    const fieldInits = data.fields.map(buildFieldMeta);
    out.push(`${I}static const keyma::FieldMeta __fields[] = {`);
    for (const fi of fieldInits) out.push(`${I}${I}${fi},`);
    out.push(`${I}};`);

    // The ClassMetadata aggregate (designated initializers; defaults omitted).
    const meta: string[] = [
        `.name = ${JSON.stringify(data.name)}`,
        `.source_name = ${JSON.stringify(data.sourceName)}`,
    ];
    if (data.visibility === "private") meta.push(`.visibility = keyma::Visibility::Private`);
    if (data.ephemeral === true) meta.push(`.ephemeral = true`);
    meta.push(`.fields = std::span<const keyma::FieldMeta>{__fields}`);
    if (data.indexes.length > 0) meta.push(`.indexes = std::span<const keyma::IndexMeta>{__idx}`);
    if (data.refs.length > 0) meta.push(`.refs = std::span<const std::pair<std::string_view, const keyma::ClassMetadata& (*)()>>{__refs}`);
    if (data.base !== undefined) meta.push(`.base = &${data.base}::metadata`);
    if (data.applyDefaults !== undefined) meta.push(`.apply_defaults = &${data.applyDefaults}`);

    out.push(`${I}static const keyma::ClassMetadata __meta{ ${meta.join(", ")} };`);
    out.push(`${I}return __meta;`);
    return out.join("\n");
}

function buildFieldMeta(field: CppFieldData): string {
    const parts: string[] = [`.name = ${JSON.stringify(field.name)}`, `.type = ${typeTag(field.type)}`];
    if (!field.required) parts.push(`.required = false`);
    if (field.nullable === true) parts.push(`.nullable = true`);
    if (field.readonly === true) parts.push(`.readonly = true`);
    if (field.indexed === true) parts.push(`.indexed = true`);
    if (field.visibility === "private") parts.push(`.visibility = keyma::Visibility::Private`);
    // Nested-type wire detail (consumed by serialize.hpp and the binary codec). For an array
    // the element carries the relevant bits/unsigned/target/idType (TypeInfo::element_of), so
    // resolve the "core" type first. `.element`/`.target` precede validators in declaration
    // order; `.bits`/`.is_unsigned`/`.id_type`/`.id_unsigned` trail `.tag`.
    const core = field.type.kind === "array" ? field.type.of : field.type;
    if (field.type.kind === "array") parts.push(`.element = ${typeTag(core)}`);
    if (core.kind === "embedded" || core.kind === "reference") parts.push(`.target = ${JSON.stringify(core.target)}`);
    if (field.validators !== undefined && field.validators.length > 0) parts.push(`.validators = std::span<const keyma::ValidatorFn>{__v_${field.name}}`);
    if (field.formatters !== undefined && field.formatters.length > 0) parts.push(`.formatters = std::span<const keyma::PhasedFormatter>{__f_${field.name}}`);
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

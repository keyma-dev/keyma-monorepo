import type { MetadataClassDescriptor, MetadataFieldDescriptor, MetadataRef } from "../driver/index.js";
import { typeTag } from "./ir-type-to-cpp.js";

/**
 * Render a class's `keyma::ClassMetadata` accessor body from the neutral
 * {@link MetadataClassDescriptor} a domain pack produces, the live `refs` (computed by the
 * bundle shell as identity `name` → fully-qualified C++ struct), and the parent's `base` FQN.
 * The generic C++ backend owns all of this language syntax — the function-local static backing
 * arrays for the class indexes and refs, the `FieldMeta` array, and the final `ClassMetadata`
 * aggregate — while the domain contributes only data.
 *
 * Unlike JS/Python, C++ metadata SHEDS the per-field validators/formatters AND the per-class
 * apply_defaults (the typed B path owns that logic; construction owns defaulting), so this
 * renderer carries only introspective data + the wire detail derived from each field's IR type.
 * The metadata's snake_case identity (`source_name`, …) and the `FieldMeta` member order are
 * the runtime contract; this renderer is the sole owner of both.
 */

const I = "    ";

export function emitClassMeta(
    descriptor: MetadataClassDescriptor,
    refs: readonly MetadataRef[],
    baseFqn?: string,
): string {
    const out: string[] = [];

    // Class-level indexes condense to bare field names + a boolean unique (server bundles only —
    // already gated by the builder).
    const indexes = (descriptor.indexes ?? []).map((idx) => ({
        fields: idx.fields.map((fld) => fld.name),
        unique: idx.unique === true,
    }));

    indexes.forEach((idx, n) => {
        const names = idx.fields.map((fld) => JSON.stringify(fld)).join(", ");
        out.push(`${I}static const std::string_view __idxf_${n}[] = { ${names} };`);
    });
    if (indexes.length > 0) {
        const items = indexes.map((idx, n) => `{ std::span<const std::string_view>{__idxf_${n}}, ${idx.unique} }`);
        out.push(`${I}static const keyma::IndexMeta __idx[] = { ${items.join(", ")} };`);
    }

    // refs map (embedded/reference targets → their metadata accessor).
    if (refs.length > 0) {
        const entries = refs.map((r) => `{ ${JSON.stringify(r.name)}, &${r.target}::metadata }`);
        out.push(`${I}static const std::pair<std::string_view, const keyma::ClassMetadata& (*)()> __refs[] = { ${entries.join(", ")} };`);
    }

    // Field metadata array.
    const fieldInits = descriptor.fields.map(buildFieldMeta);
    out.push(`${I}static const keyma::FieldMeta __fields[] = {`);
    for (const fi of fieldInits) out.push(`${I}${I}${fi},`);
    out.push(`${I}};`);

    // The ClassMetadata aggregate (designated initializers; defaults omitted).
    const meta: string[] = [
        `.name = ${JSON.stringify(descriptor.name)}`,
        `.source_name = ${JSON.stringify(descriptor.sourceName)}`,
    ];
    if (descriptor.visibility === "private") meta.push(`.visibility = keyma::Visibility::Private`);
    if (descriptor.ephemeral === true) meta.push(`.ephemeral = true`);
    meta.push(`.fields = std::span<const keyma::FieldMeta>{__fields}`);
    if (indexes.length > 0) meta.push(`.indexes = std::span<const keyma::IndexMeta>{__idx}`);
    if (refs.length > 0) meta.push(`.refs = std::span<const std::pair<std::string_view, const keyma::ClassMetadata& (*)()>>{__refs}`);
    if (baseFqn !== undefined) meta.push(`.base = &${baseFqn}::metadata`);

    out.push(`${I}static const keyma::ClassMetadata __meta{ ${meta.join(", ")} };`);
    out.push(`${I}return __meta;`);
    return out.join("\n");
}

function buildFieldMeta(field: MetadataFieldDescriptor): string {
    const parts: string[] = [`.name = ${JSON.stringify(field.name)}`, `.type = ${typeTag(field.type)}`];
    if (!field.required) parts.push(`.required = false`);
    if (field.nullable === true) parts.push(`.nullable = true`);
    if (field.readonly === true) parts.push(`.readonly = true`);
    if (field.indexes !== undefined && field.indexes.length > 0) parts.push(`.indexed = true`);
    if (field.visibility === "private") parts.push(`.visibility = keyma::Visibility::Private`);
    // Nested-type wire detail (consumed by serialize.hpp and the binary codec). For an array
    // the element carries the relevant bits/unsigned/target/idType (TypeInfo::element_of), so
    // resolve the "core" type first. `.element`/`.target` precede `.tag` in declaration order;
    // `.bits`/`.is_unsigned`/`.id_type`/`.id_unsigned` trail `.tag`.
    const core = field.type.kind === "array" ? field.type.of : field.type;
    if (field.type.kind === "array") parts.push(`.element = ${typeTag(core)}`);
    if (core.kind === "embedded" || core.kind === "reference") parts.push(`.target = ${JSON.stringify(core.target)}`);
    // Stable binary wire tag (present only when binary serialization is enabled).
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

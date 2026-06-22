import type { IREnumDeclaration } from "@keyma/ir";
import { cppSanitizer } from "./module-path.js";

/**
 * A named enum lowers to an `enum class` plus full specializations of the generic
 * `keyma::to_string<E>` / `keyma::from_string<E>` templates (declared in the support
 * header). Enums follow source-file layout like models: the `enum class` lands in the
 * declaring file's module namespace (`<ns>::models::<module>`), emitted before the
 * structs that may hold it by value; the conversion specializations sit in a separate
 * `namespace keyma` block once the enum is complete.
 */

/** The `enum class` definition (unqualified) — emitted inside the module's own namespace. */
export function emitEnumClass(decl: IREnumDeclaration): string {
    const members = decl.members.map((m) => cppSanitizer(m.name)).join(", ");
    return `enum class ${cppSanitizer(decl.name)} { ${members} };`;
}

/**
 * The `keyma::to_string`/`keyma::from_string` full specializations for one enum.
 * `qualifiedType` is the enum's fully-qualified C++ type (e.g.
 * `app::models::catalog::Status`).
 */
export function emitEnumConversions(decl: IREnumDeclaration, qualifiedType: string): string {
    const E = qualifiedType;
    const toCases = decl.members
        .map((m) => `case ${E}::${cppSanitizer(m.name)}: return ${JSON.stringify(m.value)};`)
        .join(" ");
    const fromIfs = decl.members
        .map((m) => `    if (s == ${JSON.stringify(m.value)}) return ${E}::${cppSanitizer(m.name)};`)
        .join("\n");
    return [
        `namespace keyma {`,
        `template <> inline std::string_view to_string<${E}>(${E} v) {`,
        `    switch (v) { ${toCases} }`,
        `    return {};`,
        `}`,
        `template <> inline ${E} from_string<${E}>(std::string_view s) {`,
        fromIfs,
        `    throw std::runtime_error(${JSON.stringify(`invalid ${decl.name}`)});`,
        `}`,
        // value_traits so the enum participates in the generic from_value/to_value layer
        // (a named enum is not a leaf the non-template to_value overloads cover).
        `template <> struct value_traits<${E}> {`,
        `    static ${E} from_value(const keyma::Value& v, keyma::alloc_t) {`,
        `        return v.is_string() ? keyma::from_string<${E}>(v.as_string()) : ${E}{};`,
        `    }`,
        `    static keyma::Value to_value(${E} e, keyma::alloc_t a) { return keyma::Value(keyma::to_string(e), a); }`,
        `};`,
        `}  // namespace keyma`,
        // std::format support, so the enum can be interpolated in template literals.
        `template <>`,
        `struct std::formatter<${E}, char> {`,
        `    constexpr auto parse(std::format_parse_context& ctx) { return ctx.begin(); }`,
        `    auto format(${E} v, std::format_context& ctx) const { return std::format_to(ctx.out(), "{}", keyma::to_string(v)); }`,
        `};`,
    ].join("\n");
}

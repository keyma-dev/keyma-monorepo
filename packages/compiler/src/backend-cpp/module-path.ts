import { moduleOf as moduleOfWith, moduleRefOf as moduleRefOfWith } from "@keyma/core/util";

export { isLocal } from "@keyma/core/util";

/** C++ keywords (and a few contextual ones) that must not be emitted as bare identifiers. */
const CPP_KEYWORDS = new Set([
    "alignas", "alignof", "and", "and_eq", "asm", "auto", "bitand", "bitor", "bool", "break",
    "case", "catch", "char", "char8_t", "char16_t", "char32_t", "class", "compl", "concept",
    "const", "consteval", "constexpr", "constinit", "const_cast", "continue", "co_await",
    "co_return", "co_yield", "decltype", "default", "delete", "do", "double", "dynamic_cast",
    "else", "enum", "explicit", "export", "extern", "false", "float", "for", "friend", "goto",
    "if", "inline", "int", "long", "mutable", "namespace", "new", "noexcept", "not", "not_eq",
    "nullptr", "operator", "or", "or_eq", "private", "protected", "public", "register",
    "reinterpret_cast", "requires", "return", "short", "signed", "sizeof", "static",
    "static_assert", "static_cast", "struct", "switch", "template", "this", "thread_local",
    "throw", "true", "try", "typedef", "typeid", "typename", "union", "unsigned", "using",
    "virtual", "void", "volatile", "wchar_t", "while", "xor", "xor_eq",
]);

/**
 * Sanitize one output path segment / identifier to a valid C++ name: replace any
 * non-`[A-Za-z0-9_]` with `_`, prefix `_` if it starts with a digit, and suffix `_`
 * if the result is a C++ keyword.
 */
export function cppSanitizer(segment: string): string {
    let out = segment.replace(/[^A-Za-z0-9_]/g, "_");
    if (/^[0-9]/.test(out)) out = `_${out}`;
    if (CPP_KEYWORDS.has(out)) out = `${out}_`;
    return out;
}

/**
 * POSIX module path (no extension) mirroring a source file's location relative to
 * `sourceRoot`, with each segment sanitized to a valid C++ identifier. Derived from
 * the SOURCE file's stem — never the schema name — so `user-credentials.ts` lands in
 * `user_credentials` and an `@Edge({ name: "KNOWS" })` in `user.ts` lands in `user`.
 */
export function moduleOf(sourceFile: string, sourceRoot: string | undefined): string {
    return moduleOfWith(sourceFile, sourceRoot, cppSanitizer);
}

/**
 * The bundle-relative module ref a declaration emits into: project-local declarations under
 * `src/` (mirroring their source layout), out-of-project (library) declarations into the
 * single shared `vendor` module. Segments are sanitized to valid C++ identifiers.
 */
export function moduleRefOf(sourceFile: string, sourceRoot: string | undefined): string {
    return moduleRefOfWith(sourceFile, sourceRoot, cppSanitizer);
}

/**
 * The quoted-include path for a bundle-relative module ref, e.g. `models/user` →
 * `"models/user.hpp"`. Headers reference each other by their bundle-relative path; the
 * bundle root must be on the compiler include path (`-I <bundleDir>`). Independent of
 * the including file, so the include text is a pure function of the target.
 */
export function includePath(toRef: string): string {
    return `${toRef}.hpp`;
}

/**
 * The C++ namespace for a bundle-relative module ref: the root namespace followed by
 * the ref's path segments, each sanitized. E.g. (`models/user`, `keyma`) →
 * `keyma::models::user`; (`validators`, `keyma`) → `keyma::validators`.
 */
export function namespaceOf(moduleRef: string, namespaceRoot: string): string {
    return [namespaceRoot, ...moduleRef.split("/")].map(cppSanitizer).join("::");
}

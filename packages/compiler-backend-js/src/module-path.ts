import { path } from "@keyma/compiler-util";

// Source-file → output-module-path helpers are shared across the language backends.
export { moduleOf, isLocal, identitySanitizer } from "@keyma/compiler-util";
export type { Sanitizer } from "@keyma/compiler-util";

/** A relative module specifier (with `.js`) from one bundle-relative module ref to another. */
export function relModuleSpecifier(fromRef: string, toRef: string): string {
    let rel = path.posix.relative(path.posix.dirname(fromRef), toRef);
    if (!rel.startsWith(".")) rel = "./" + rel;
    return rel + ".js";
}

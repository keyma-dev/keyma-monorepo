import path from "./path.js";

/** Sanitizes one output path segment for a target language. */
export type Sanitizer = (segment: string) => string;

/** Identity sanitizer — keeps a segment verbatim (e.g. JS module specifiers allow hyphens). */
export const identitySanitizer: Sanitizer = (s) => s;

function stemOf(file: string): string {
    return path.basename(file).replace(/\.[^.]+$/, "");
}

/** Bundle-relative path prefix every project-local declaration's module sits under. Keeps
 *  generated source modules collision-safe against the bundle-root scaffolding
 *  (`index` / `types` / `vendor`) and gives a clean leading namespace segment. */
export const LOCAL_MODULE_PREFIX = "src";

/** The single shared module that collects out-of-project (library) declarations re-emitted
 *  into the output. Unified across declaration kinds and tree-shaken to referenced symbols. */
export const VENDOR_MODULE = "vendor";

/**
 * The bundle-relative module ref (no extension) a declaration emits into, derived from its
 * SOURCE file. Project-local declarations mirror their source layout under `src/`;
 * out-of-project (`!isLocal`) declarations collapse into the single shared `vendor` module.
 * The universal emission unit for every declaration kind — classes, enums, and functions.
 */
export function moduleRefOf(sourceFile: string, sourceRoot: string | undefined, sanitize: Sanitizer): string {
    if (!isLocal(sourceFile, sourceRoot)) return sanitize(VENDOR_MODULE);
    return path.posix.join(sanitize(LOCAL_MODULE_PREFIX), moduleOf(sourceFile, sourceRoot, sanitize));
}

/**
 * POSIX module path (no extension) mirroring a source file's location relative to
 * `sourceRoot`, with each segment sanitized for the target. Derived from the SOURCE
 * file's stem — never the schema name — so output filenames are stable and case-safe
 * (e.g. an `@Edge({ name: "KNOWS" })` in `user.ts` still lands in `user`).
 */
export function moduleOf(sourceFile: string, sourceRoot: string | undefined, sanitize: Sanitizer): string {
    const stem = stemOf(sourceFile);
    if (!sourceRoot) return sanitize(stem);
    const rel = path.relative(sourceRoot, sourceFile);
    const dir = path.dirname(rel);
    const segs = (dir === "." ? [] : dir.split(path.sep)).map(sanitize);
    segs.push(sanitize(stem));
    return segs.join(path.posix.sep);
}

/** Whether a source file lives inside `sourceRoot` (project-local, not a library import). */
export function isLocal(sourceFile: string, sourceRoot: string | undefined): boolean {
    if (!sourceRoot) return true;
    const rel = path.relative(sourceRoot, sourceFile);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
}

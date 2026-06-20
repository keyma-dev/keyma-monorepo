import path from "node:path";

/** Sanitizes one output path segment for a target language. */
export type Sanitizer = (segment: string) => string;

/** JS keeps source basenames verbatim (hyphens are legal in module specifiers). */
export const identitySanitizer: Sanitizer = (s) => s;

/** Python module names must be valid identifiers: non-`[A-Za-z0-9_]` → `_`, leading digit → `_` prefix. */
export const pythonSanitizer: Sanitizer = (s) => {
    const out = s.replace(/[^A-Za-z0-9_]/g, "_");
    return /^[0-9]/.test(out) ? `_${out}` : out;
};

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

/** A relative module specifier (with `.js`) from one bundle-relative module ref to another. */
export function relModuleSpecifier(fromRef: string, toRef: string): string {
    let rel = path.posix.relative(path.posix.dirname(fromRef), toRef);
    if (!rel.startsWith(".")) rel = "./" + rel;
    return rel + ".js";
}

function stemOf(file: string): string {
    return path.basename(file).replace(/\.[^.]+$/, "");
}

import path from "node:path";

/** Sanitize one output path segment to a valid Python identifier. */
export function pythonSanitizer(segment: string): string {
    const out = segment.replace(/[^A-Za-z0-9_]/g, "_");
    return /^[0-9]/.test(out) ? `_${out}` : out;
}

/**
 * POSIX module path (no extension) mirroring a source file's location relative to
 * `sourceRoot`, with each segment sanitized to a valid Python module name. Derived
 * from the SOURCE file's stem — never the schema name — so `user-credentials.ts`
 * lands in `user_credentials` and an `@Edge({ name: "KNOWS" })` in `user.ts` lands
 * in `user`.
 */
export function moduleOf(sourceFile: string, sourceRoot: string | undefined): string {
    const stem = path.basename(sourceFile).replace(/\.[^.]+$/, "");
    if (!sourceRoot) return pythonSanitizer(stem);
    const rel = path.relative(sourceRoot, sourceFile);
    const dir = path.dirname(rel);
    const segs = (dir === "." ? [] : dir.split(path.sep)).map(pythonSanitizer);
    segs.push(pythonSanitizer(stem));
    return segs.join(path.posix.sep);
}

/** Whether a source file lives inside `sourceRoot` (project-local, not a library import). */
export function isLocal(sourceFile: string, sourceRoot: string | undefined): boolean {
    if (!sourceRoot) return true;
    const rel = path.relative(sourceRoot, sourceFile);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * A Python relative-import prefix + module path from one bundle-relative module ref
 * to another, e.g. from `models/user/user` to `validators` → `from ...validators`,
 * to `models/user/address` → `from .address`. Returns `{ dots, module }` where the
 * import is `from ${dots}${module} import …`.
 */
export function pythonRelImport(fromRef: string, toRef: string): { prefix: string; module: string } {
    const fromDir = path.posix.dirname(fromRef).split("/").filter((s) => s !== ".");
    const toParts = toRef.split("/");

    // Common prefix length between the *directories*.
    const toDir = toParts.slice(0, -1);
    let common = 0;
    while (common < fromDir.length && common < toDir.length && fromDir[common] === toDir[common]) common++;

    // Go up (fromDir.length - common) packages; `.` already means current package.
    const up = fromDir.length - common;
    const prefix = ".".repeat(up + 1);
    const module = toParts.slice(common).join(".");
    return { prefix, module };
}

/**
 * Tiny self-contained POSIX path string utilities — no Node, no filesystem, no cwd.
 *
 * Replaces `node:path` across the compiler frontends/backends so they run unchanged
 * in the browser. Every function normalizes `\` → `/` on entry and treats `/` as the
 * sole separator, so `path` and `path.posix` are the same implementation (`posix ===
 * self`, `sep === "/"`). On the primary platforms (macOS/Linux) inputs already use
 * forward slashes, so output is byte-identical to `node:path`; on Windows this fixes a
 * latent inconsistency, since TypeScript's `SourceFile.fileName` is always `/`-separated.
 *
 * Operates on path strings only; it never reads a current working directory, so
 * `resolve` expects its base (first absolute) segment to be supplied by the caller —
 * which every call site does.
 */

export const sep = "/";

const norm = (p: string): string => p.replace(/\\/g, "/");

export function isAbsolute(p: string): boolean {
    return norm(p).startsWith("/");
}

/** Split into non-empty segments, tracking whether the path is rooted at "/". */
function parse(p: string): { abs: boolean; segs: string[] } {
    const s = norm(p);
    return { abs: s.startsWith("/"), segs: s.split("/").filter((seg) => seg.length > 0) };
}

/** Collapse "." and ".." against the segment list. Leading ".." survive only when relative. */
function normalizeSegs(abs: boolean, segs: readonly string[]): string[] {
    const out: string[] = [];
    for (const seg of segs) {
        if (seg === ".") continue;
        if (seg === "..") {
            const top = out[out.length - 1];
            if (out.length > 0 && top !== "..") out.pop();
            else if (!abs) out.push(".."); // above-root ".." is dropped for absolute paths
        } else {
            out.push(seg);
        }
    }
    return out;
}

export function dirname(p: string): string {
    const { abs, segs } = parse(p);
    if (segs.length <= 1) return abs ? "/" : ".";
    const dir = segs.slice(0, -1).join("/");
    return abs ? "/" + dir : dir;
}

export function basename(p: string): string {
    const { segs } = parse(p);
    return segs.length === 0 ? "" : segs[segs.length - 1]!;
}

/**
 * Right-to-left resolve (mirrors `node:path.resolve` minus cwd): stops at the first
 * absolute segment. With no cwd, a wholly-relative argument list yields a normalized
 * relative path rather than anchoring to a working directory — but every call site
 * passes an absolute base, so the result is always absolute in practice.
 */
export function resolve(...parts: string[]): string {
    let abs = false;
    const acc: string[] = [];
    for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i];
        if (part === undefined || part.length === 0) continue;
        const { abs: pAbs, segs } = parse(part);
        acc.unshift(...segs);
        if (pAbs) {
            abs = true;
            break;
        }
    }
    const body = normalizeSegs(abs, acc).join("/");
    return abs ? "/" + body : body || ".";
}

/** Relative path FROM `from` TO `to`. Mirrors `node:path.posix.relative`. */
export function relative(from: string, to: string): string {
    const a = normalizeSegs(true, parse(from).segs);
    const b = normalizeSegs(true, parse(to).segs);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

export function join(...parts: string[]): string {
    const joined = parts.filter((s) => s.length > 0).join("/");
    if (joined === "") return ".";
    const { abs, segs } = parse(joined);
    const body = normalizeSegs(abs, segs).join("/");
    return abs ? "/" + body : body || ".";
}

const path = { sep, dirname, basename, isAbsolute, resolve, relative, join };

/** POSIX namespace — identical to the top-level functions (there is only one separator). */
export const posix = path;

export default { ...path, posix };

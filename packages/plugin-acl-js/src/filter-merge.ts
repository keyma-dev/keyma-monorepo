import type { RequestContext } from "@keyma/runtime/schema";

// ── Placeholder substitution ─────────────────────────────────────────────────
//
// Walks an arbitrary filter value and replaces string-shaped placeholders:
//   "$self"          → ctx.identity.id
//   "$ctx.foo.bar"   → ctx.foo.bar
//
// Returns `null` if any placeholder cannot be resolved — callers should drop
// the surrounding rule.

const UNRESOLVED = Symbol("unresolved");
type SubResult = { ok: true; value: unknown } | { ok: false };

export function substitutePlaceholders(
    value: unknown,
    ctx: RequestContext,
): SubResult {
    if (typeof value === "string") {
        const resolved = resolvePlaceholder(value, ctx);
        if (resolved === UNRESOLVED) return { ok: false };
        return { ok: true, value: resolved };
    }
    if (Array.isArray(value)) {
        const out: unknown[] = [];
        for (const item of value) {
            const r = substitutePlaceholders(item, ctx);
            if (!r.ok) return { ok: false };
            out.push(r.value);
        }
        return { ok: true, value: out };
    }
    if (typeof value === "object" && value !== null) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const r = substitutePlaceholders(v, ctx);
            if (!r.ok) return { ok: false };
            out[k] = r.value;
        }
        return { ok: true, value: out };
    }
    return { ok: true, value };
}

function resolvePlaceholder(s: string, ctx: RequestContext): unknown | typeof UNRESOLVED {
    if (!s.startsWith("$")) return s;
    if (s === "$self") {
        const id = ctx.identity?.id;
        return id ?? UNRESOLVED;
    }
    if (s.startsWith("$ctx.")) {
        const path = s.slice(5).split(".");
        let cur: unknown = ctx;
        for (const seg of path) {
            if (cur === null || cur === undefined || typeof cur !== "object") {
                return UNRESOLVED;
            }
            cur = (cur as Record<string, unknown>)[seg];
        }
        return cur ?? UNRESOLVED;
    }
    // Anything else with a "$" prefix is a Mongo operator key (handled via the
    // surrounding object walk) or a literal — leave alone.
    return s;
}

/** Substitute placeholders inside a filter; returns undefined if any
 *  placeholder is unresolvable (rule should be skipped). */
export function substituteFilter(
    filter: Record<string, unknown> | undefined,
    ctx: RequestContext,
): Record<string, unknown> | undefined {
    if (filter === undefined) return undefined;
    const r = substitutePlaceholders(filter, ctx);
    if (!r.ok) return undefined;
    return r.value as Record<string, unknown>;
}

// ── Filter combinators ───────────────────────────────────────────────────────
//
// Outputs are MongoDB-style: $and / $or / $nor. Empty filter "{}" is treated
// as "matches all" — it short-circuits OR and is dropped from AND.

function isEmpty(f: Record<string, unknown>): boolean {
    return Object.keys(f).length === 0;
}

export function combineAnd(
    filters: ReadonlyArray<Record<string, unknown> | undefined>,
): Record<string, unknown> {
    const nonEmpty = filters.filter(
        (f): f is Record<string, unknown> => f !== undefined && !isEmpty(f),
    );
    if (nonEmpty.length === 0) return {};
    if (nonEmpty.length === 1) return nonEmpty[0]!;
    return { $and: nonEmpty };
}

/** OR of filters. If any filter is empty ("matches all"), the result is
 *  empty — OR-ing with "matches all" matches everything. */
export function combineOr(
    filters: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
    if (filters.length === 0) return MATCHES_NONE;
    if (filters.some(isEmpty)) return {};
    if (filters.length === 1) return filters[0]!;
    return { $or: [...filters] };
}

/** NOR — matches docs that match none of the supplied filters. Returns `{}`
 *  ("no restriction") for an empty list. */
export function combineNor(
    filters: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
    if (filters.length === 0) return {};
    return { $nor: [...filters] };
}

/** A filter that matches no document. Used when ACL evaluation produces no
 *  allowed rows but we don't want to leak via FORBIDDEN — equivalent to
 *  "list with no permission" silently returns []. Not currently used by the
 *  plugin's default path (we throw AclDenied) but exposed for callers that
 *  want soft-deny behavior. */
export const MATCHES_NONE: Record<string, unknown> = { _aclMatchesNone: true };

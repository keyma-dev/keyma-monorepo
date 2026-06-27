import type { IRMethod, IRStaticMember, IRStatement, IRExpression } from "../ir/index.js";

/** The three bundle audiences a backend emits for. "client" is never a gated audience —
 *  `bodyAudience`/`audience` list only "server"/"library", so the client always falls back. */
export type Bundle = "client" | "server" | "library";

/**
 * The statements a method's body emits for one bundle: the domain-provided `fallback` when the
 * method carries a {@link IRMethod.bodyAudience} the bundle's audience is NOT listed in, else the
 * real `statements`. Keeps the method SIGNATURE uniform across bundles while letting a server-only
 * body collapse to a no-op (e.g. `formatSave` → identity on the client). Audience-mechanical and
 * domain-agnostic — every language backend's method emitter routes its body through this.
 */
export function methodBodyForBundle(method: IRMethod, bundle: Bundle): IRStatement[] {
    const ba = method.bodyAudience;
    if (ba === undefined) return method.statements;
    return ba.audiences.includes(bundle as "server" | "library") ? method.statements : ba.fallback;
}

/**
 * The value a static member emits for one bundle: the domain-provided `fallback` when the member
 * carries an {@link IRStaticMember.audience} the bundle's audience is NOT listed in, else the real
 * `value` (so a client bundle can carry a reduced metadata while the member stays present and
 * uniformly named). Mirrors {@link methodBodyForBundle} for the static-member channel.
 */
export function staticValueForBundle(s: IRStaticMember, bundle: Bundle): IRExpression {
    if (s.audience === undefined) return s.value;
    return s.audience.audiences.includes(bundle as "server" | "library") ? s.value : s.audience.fallback;
}

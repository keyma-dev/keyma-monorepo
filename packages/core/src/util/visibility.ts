import type { IRClassDeclaration, IRField, IRMethod } from "../ir/index.js";

/**
 * Filter a list of visibility-bearing items (fields, methods, service methods) down to
 * the ones a bundle may emit: everything when `includePrivate`, otherwise public-only.
 * Generic over any `{ visibility }` shape so it serves schema fields/methods and service
 * methods alike. Always returns a fresh array.
 */
export function filterVisible<T extends { visibility: string }>(items: readonly T[], includePrivate: boolean): T[] {
    return includePrivate ? items.slice() : items.filter((i) => i.visibility === "public");
}

/** A schema's fields filtered by visibility (public-only unless `includePrivate`). */
export function filterVisibleFields(schema: IRClassDeclaration, includePrivate: boolean): IRField[] {
    return filterVisible(schema.fields, includePrivate);
}

/** A schema's methods filtered by visibility (public-only unless `includePrivate`). */
export function filterVisibleMethods(schema: IRClassDeclaration, includePrivate: boolean): IRMethod[] {
    return filterVisible(schema.methods ?? [], includePrivate);
}

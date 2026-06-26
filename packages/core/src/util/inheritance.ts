import type { IRClassDeclaration, IRField } from "../ir/index.js";

/**
 * The complete field list for a schema — its own fields plus every inherited one —
 * assembled by walking the `extends` chain root-first and overriding by name with the
 * more-derived field. `schemaBySourceName` resolves each `extends` parent (keyed by
 * `sourceName`, the emit symbol that `extends` holds). A schema with no parent returns
 * its own fields unchanged. Always a fresh array.
 *
 * This is the inheritance-aware counterpart to reading `schema.fields` directly: backends
 * emit OWN fields into the class body (real inheritance handles the rest) but enumerate the
 * full set here when they must produce flat data (C++ value_traits/binary codecs, etc.).
 * The ordering — parent fields first, child overrides keeping the parent's position —
 * matches the old flatten pass, so wire output stays byte-identical.
 */
export function inheritedFields(
    schema: IRClassDeclaration,
    schemaBySourceName: ReadonlyMap<string, IRClassDeclaration>,
): IRField[] {
    if (schema.extends === undefined) return schema.fields.slice();

    // Walk child → ... → root, guarding against cycles (the frontend rejects them, but a
    // malformed map must not loop here).
    const chain: IRClassDeclaration[] = [];
    const seen = new Set<string>();
    let cur: IRClassDeclaration | undefined = schema;
    while (cur !== undefined && !seen.has(cur.sourceName)) {
        seen.add(cur.sourceName);
        chain.push(cur);
        cur = cur.extends !== undefined ? schemaBySourceName.get(cur.extends) : undefined;
    }

    // Insert root-first so a child override keeps the parent field's position.
    const byName = new Map<string, IRField>();
    for (let i = chain.length - 1; i >= 0; i--) {
        for (const f of chain[i]!.fields) byName.set(f.name, f);
    }
    return [...byName.values()];
}

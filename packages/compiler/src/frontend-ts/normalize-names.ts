import type { IRClassDeclaration, IRType } from "@keyma/core/ir";

/**
 * Apply the configured name prefix to every class `name` and rewrite each field's
 * reference/embedded target from the authored class name (`sourceName`) to the target's final
 * (prefixed) `name`. In-place mutation of the (already lowered, validated) IR. Returns the
 * `sourceName → finalName` map so a domain's post-normalize hook can rewrite its own extension
 * cross-references (e.g. edge `from`/`to`/`label`) against the same identities.
 *
 * The map is built from the original (un-prefixed) names BEFORE any mutation, so the order of
 * the rewrite loop is irrelevant — every target resolves through the precomputed map.
 */
export function normalizeClassNames(
    classes: IRClassDeclaration[],
    prefix: string,
): ReadonlyMap<string, string> {
    // Authored class name (sourceName) -> final identity (prefixed name).
    const finalName = new Map<string, string>();
    for (const s of classes) finalName.set(s.sourceName, prefix + s.name);

    const rewrite = (type: IRType): void => {
        if (type.kind === "array") {
            rewrite(type.of);
        } else if (type.kind === "reference" || type.kind === "embedded") {
            type.target = finalName.get(type.target) ?? type.target;
        }
    };

    for (const s of classes) {
        for (const f of s.fields) rewrite(f.type);
        s.name = prefix + s.name;
    }

    return finalName;
}

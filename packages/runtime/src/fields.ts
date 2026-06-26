import type { SchemaMetadata, FieldMetadata, SchemaClass } from "./types.js";

// The full field set of a schema, own + inherited (real inheritance). `SchemaMetadata.fields`
// holds OWN fields only; inherited fields live on the `base` chain. This assembles the complete
// set base-first (root → … → leaf), a child field overriding an inherited one of the same name
// while keeping the ancestor's position — identical to the order the old field-flattening pass
// produced, so JSON key order, binary field order, and snapshots stay byte-stable. It also
// mirrors the compiler's `inheritedFields` (and the C++ runtime's `all_fields`), which is what
// `value_traits`/`binary_traits` enumerate, so the cross-runtime wire contract is preserved.
//
// Results are memoized: schema metadata objects are frozen singletons created once at module
// load, so the full set never changes for a given schema.
const cache = new WeakMap<SchemaMetadata, readonly FieldMetadata[]>();

export function allFields(schema: SchemaMetadata): readonly FieldMetadata[] {
    if (schema.base === undefined) return schema.fields;
    const memo = cache.get(schema);
    if (memo !== undefined) return memo;

    // Walk the base chain leaf-first (cycle-guarded by canonical `name`).
    const chain: SchemaMetadata[] = [];
    const seen = new Set<string>();
    let cur: SchemaMetadata | undefined = schema;
    while (cur !== undefined && !seen.has(cur.name)) {
        seen.add(cur.name);
        chain.push(cur);
        cur = cur.base;
    }

    // Emit root-first; a Map keyed by field name gives each field the ancestor-position of its
    // first declaration while a child override supplies the winning definition.
    const byName = new Map<string, FieldMetadata>();
    for (let i = chain.length - 1; i >= 0; i--) {
        for (const f of chain[i]!.fields) byName.set(f.name, f);
    }
    const result: readonly FieldMetadata[] = [...byName.values()];
    cache.set(schema, result);
    return result;
}

// `SchemaMetadata.refs` (embedded/reference target `name` → class) holds OWN fields' targets
// only (real inheritance). An inherited embedded/reference field's target lives in an ancestor's
// `refs`, so resolve a target name by walking the base chain leaf-first (a child entry shadows an
// ancestor's of the same name). Mirrors the C++ runtime's `resolve_ref`. Returns undefined when
// no schema in the chain declares the name (or the schema has no inheritance and no match).
const refsCache = new WeakMap<SchemaMetadata, ReadonlyMap<string, SchemaClass>>();

export function allRefs(schema: SchemaMetadata): ReadonlyMap<string, SchemaClass> {
    if (schema.base === undefined) return schema.refs ?? EMPTY_REFS;
    const memo = refsCache.get(schema);
    if (memo !== undefined) return memo;

    // Walk leaf → root, collecting each schema's own refs; a leaf entry must win, so only set a
    // key the first time it is seen (leaf-first order means the leaf is seen first).
    const merged = new Map<string, SchemaClass>();
    const seen = new Set<string>();
    for (let s: SchemaMetadata | undefined = schema; s !== undefined && !seen.has(s.name); s = s.base) {
        seen.add(s.name);
        if (s.refs === undefined) continue;
        for (const [k, v] of s.refs) if (!merged.has(k)) merged.set(k, v);
    }
    refsCache.set(schema, merged);
    return merged;
}

const EMPTY_REFS: ReadonlyMap<string, SchemaClass> = new Map();

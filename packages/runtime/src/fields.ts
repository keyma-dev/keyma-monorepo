// Codec-facing metadata shape + field-chain helpers.
//
// IMPORTANT — the codec operates on the EMITTED data-model shape, not the legacy
// `SchemaMetadata`/`SchemaClass` declarations in `types.ts` (those survive only as the
// schema-domain generator's slicing source). A generated bundle's `<Class>.metadata` is a
// `ClassMetadata` whose reference/embedded field types carry `target` (not `schema`), whose
// brand exposes the metadata under `.metadata` (not `.schema`), and whose instances hydrate via
// the static `fromValue` factory (not `new Class(value)`). The structural types below mirror
// that emitted shape exactly, so the authored-here codec is baked verbatim and runs unchanged
// against generated classes.

/** A value type — the codec subset of the core IRType. `reference`/`embedded` carry the
 *  target class's canonical `name` under `target`; `instance` (param/return positions only,
 *  never a stored field) carries it under `name`. */
export type FieldType =
    | { kind: "string" }
    | { kind: "number"; bits?: 32 | 64 }
    | { kind: "integer"; bits?: 8 | 16 | 32 | 64; unsigned?: boolean }
    | { kind: "bigint" }
    | { kind: "boolean" }
    | { kind: "decimal" }
    | { kind: "bytes" }
    | { kind: "json" }
    | { kind: "date" }
    | { kind: "dateTime" }
    | { kind: "time" }
    | { kind: "id" }
    | { kind: "enum"; values: string[] }
    | { kind: "array"; of: FieldType; elementNullable?: boolean }
    | { kind: "reference"; target: string; idType?: FieldType }
    | { kind: "embedded"; target: string }
    | { kind: "instance"; name: string };

export type FieldMeta = {
    name: string;
    type: FieldType;
    /** Stable wire tag for binary serialization. Absent ⇒ the 1-based declaration index. */
    tag?: number;
};

/** The structural subset of a generated `<Class>.metadata` the codec reads. */
export type ClassMeta = {
    name: string;
    /** OWN fields only (real inheritance) — inherited fields live on `base`. */
    fields: FieldMeta[];
    /** Parent class's metadata when this class extends another; absent for a root. */
    base?: ClassMeta;
    /** Reference/embedded/instance target `name` → generated class. */
    refs?: ReadonlyMap<string, ClassRef>;
};

/** The structural subset of a generated model class the codec needs: its `metadata` brand and
 *  the static `fromValue` hydration factory. */
export interface ClassRef {
    readonly metadata: ClassMeta;
    fromValue(value: unknown): unknown;
}

// The full field set of a class, own + inherited (real inheritance). `ClassMeta.fields` holds
// OWN fields only; inherited fields live on the `base` chain. Assembled base-first (root → … →
// leaf), a child field overriding an inherited one of the same name while keeping the ancestor's
// position — identical to the order the compiler's `inheritedFields` (and the C++ `all_fields`)
// produce, so JSON key order and binary field order stay byte-stable across runtimes.
//
// Memoized: metadata objects are frozen singletons created once at module load.
const cache = new WeakMap<ClassMeta, readonly FieldMeta[]>();

export function allFields(meta: ClassMeta): readonly FieldMeta[] {
    if (meta.base === undefined) return meta.fields;
    const memo = cache.get(meta);
    if (memo !== undefined) return memo;

    // Walk the base chain leaf-first (cycle-guarded by canonical `name`).
    const chain: ClassMeta[] = [];
    const seen = new Set<string>();
    let cur: ClassMeta | undefined = meta;
    while (cur !== undefined && !seen.has(cur.name)) {
        seen.add(cur.name);
        chain.push(cur);
        cur = cur.base;
    }

    // Emit root-first; a Map keyed by field name gives each field the ancestor-position of its
    // first declaration while a child override supplies the winning definition.
    const byName = new Map<string, FieldMeta>();
    for (let i = chain.length - 1; i >= 0; i--) {
        for (const f of chain[i]!.fields) byName.set(f.name, f);
    }
    const result: readonly FieldMeta[] = [...byName.values()];
    cache.set(meta, result);
    return result;
}

// `ClassMeta.refs` holds OWN fields' targets only (real inheritance). An inherited
// embedded/reference/instance field's target lives in an ancestor's `refs`, so resolve a target
// name by walking the base chain leaf-first (a child entry shadows an ancestor's of the same
// name). Returns undefined when no class in the chain declares the name.
const refsCache = new WeakMap<ClassMeta, ReadonlyMap<string, ClassRef>>();

export function allRefs(meta: ClassMeta): ReadonlyMap<string, ClassRef> {
    if (meta.base === undefined) return meta.refs ?? EMPTY_REFS;
    const memo = refsCache.get(meta);
    if (memo !== undefined) return memo;

    const merged = new Map<string, ClassRef>();
    const seen = new Set<string>();
    for (let m: ClassMeta | undefined = meta; m !== undefined && !seen.has(m.name); m = m.base) {
        seen.add(m.name);
        if (m.refs === undefined) continue;
        for (const [k, v] of m.refs) if (!merged.has(k)) merged.set(k, v);
    }
    refsCache.set(meta, merged);
    return merged;
}

const EMPTY_REFS: ReadonlyMap<string, ClassRef> = new Map();

/** Resolve the target class `name` of a reference/embedded/instance type (undefined otherwise). */
export function targetOf(type: FieldType): string | undefined {
    if (type.kind === "reference" || type.kind === "embedded") return type.target;
    if (type.kind === "instance") return type.name;
    return undefined;
}

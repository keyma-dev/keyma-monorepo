import type { SchemaMetadata, FieldMetadata } from "./types.js";

// Own + inherited fields of a schema, assembled base-first (real inheritance). The
// validate/format/applyDefaults drivers operate on the legacy `SchemaMetadata` shape
// (`types.ts`), which still carries `validators`/`formatters`/`default` — the schema backend
// keeps emitting those into `<Class>.metadata`. This is DISTINCT from the codec's `ClassMeta`
// `allFields` in `fields.ts`, whose `FieldMeta` sheds those validation keys; the two metadata
// worlds share the same base-first ordering but not the same field type.
//
// Memoized: metadata objects are frozen singletons created once at module load. Cycle-guarded by
// canonical `name`, a child field overriding an inherited one of the same name while keeping the
// ancestor's position — so the validated field set matches the codec's wire order exactly.
const cache = new WeakMap<SchemaMetadata, readonly FieldMetadata[]>();

export function allSchemaFields(schema: SchemaMetadata): readonly FieldMetadata[] {
    if (schema.base === undefined) return schema.fields;
    const memo = cache.get(schema);
    if (memo !== undefined) return memo;

    const chain: SchemaMetadata[] = [];
    const seen = new Set<string>();
    for (let s: SchemaMetadata | undefined = schema; s !== undefined && !seen.has(s.name); s = s.base) {
        seen.add(s.name);
        chain.push(s);
    }

    const byName = new Map<string, FieldMetadata>();
    for (let i = chain.length - 1; i >= 0; i--) {
        for (const f of chain[i]!.fields) byName.set(f.name, f);
    }
    const result: readonly FieldMetadata[] = [...byName.values()];
    cache.set(schema, result);
    return result;
}

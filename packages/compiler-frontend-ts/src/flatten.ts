import type { IRSchema, IRField, IRType, IRIndex, IRMethod, IRDiagnostic } from "@keyma/ir";
import { mkError, KEYMA032, KEYMA033, KEYMA034 } from "./diagnostics.js";

type FlattenContext = {
    /** Map from sourceName → extracted (pre-flatten) schema. */
    schemas: ReadonlyMap<string, IRSchema>;
    diagnostics: IRDiagnostic[];
};

/**
 * Flatten inheritance for all schemas.
 * Returns a new list of schemas where each schema's field list is the complete
 * flattened set (parent fields first, child fields overriding).
 */
export function flattenAll(schemas: IRSchema[], ctx: FlattenContext): IRSchema[] {
    const result: IRSchema[] = [];
    for (const schema of schemas) {
        result.push(flattenSchema(schema, ctx, new Set()));
    }
    return result;
}

function flattenSchema(
    schema: IRSchema,
    ctx: FlattenContext,
    visiting: Set<string>
): IRSchema {
    if (!schema.extends) return schema; // no inheritance, already flat

    const parentName = schema.extends;

    if (visiting.has(schema.sourceName)) {
        // Circular — skip (shouldn't happen in valid TS)
        return schema;
    }

    const parent = ctx.schemas.get(parentName);
    if (!parent) {
        ctx.diagnostics.push(
            mkError(KEYMA033, `"${schema.sourceName}" extends "${parentName}" which is not a @Schema class`, schema.source)
        );
        return schema;
    }

    // KEYMA032: public child cannot extend private parent
    if (schema.visibility === "public" && parent.visibility === "private") {
        ctx.diagnostics.push(
            mkError(KEYMA032, `Public schema "${schema.sourceName}" cannot extend private schema "${parentName}"`, schema.source)
        );
    }

    // Recursively flatten the parent first
    visiting.add(schema.sourceName);
    const flatParent = flattenSchema(parent, ctx, visiting);
    visiting.delete(schema.sourceName);

    // Merge fields: parent first, child overrides by name
    const mergedFields = mergeFields(flatParent.fields, schema.fields, schema, ctx);

    // Merge composite indexes: concatenate and deduplicate
    const mergedIndexes = mergeIndexes(flatParent.indexes, schema.indexes);

    // Inherited behaviors flatten in alongside fields: parent methods first, child
    // methods override by name.
    const mergedMethods = mergeMethods(flatParent.methods ?? [], schema.methods ?? []);

    // The flattened schema is self-contained: drop `extends` so backends don't
    // re-apply inheritance (which would double-assign inherited fields), and keep
    // the parent name only as provenance.
    const { extends: _dropped, ...rest } = schema;
    const out: IRSchema = {
        ...rest,
        extendsSource: parentName,
        fields: mergedFields,
        indexes: mergedIndexes,
    };
    if (mergedMethods.length > 0) out.methods = mergedMethods;
    else delete out.methods;
    return out;
}

/**
 * Merge inherited and own behaviors; a child behavior overrides a parent's by
 * identity. Identity is `kind:name`, not `name` alone, so a getter and a setter of
 * the same name (an accessor pair) coexist instead of clobbering each other.
 */
function mergeMethods(parentMethods: IRMethod[], childMethods: IRMethod[]): IRMethod[] {
    const result = new Map<string, IRMethod>();
    const key = (m: IRMethod): string => `${m.kind}:${m.name}`;
    for (const m of parentMethods) result.set(key(m), m);
    for (const m of childMethods) result.set(key(m), m);
    return [...result.values()];
}

function mergeFields(
    parentFields: IRField[],
    childFields: IRField[],
    childSchema: IRSchema,
    ctx: FlattenContext
): IRField[] {
    const result = new Map<string, IRField>();

    for (const f of parentFields) {
        result.set(f.name, f);
    }

    for (const f of childFields) {
        const existing = result.get(f.name);
        if (existing) {
            // A child override must be a SUBTYPE of the parent field, so existing
            // readers of the parent type stay valid.
            if (!fieldOverrideCompatible(existing, f)) {
                ctx.diagnostics.push(
                    mkError(
                        KEYMA034,
                        `Field "${f.name}" in "${childSchema.sourceName}" narrows incompatibly: ` +
                        `parent ${fieldLabel(existing)}, child ${fieldLabel(f)}`,
                        f.source
                    )
                );
            }
        }
        result.set(f.name, f);
    }

    return [...result.values()];
}

/** A child field override must be a subtype of the parent field. */
function fieldOverrideCompatible(parent: IRField, child: IRField): boolean {
    // A child cannot introduce null a parent reader does not expect (widening).
    if (!(parent.nullable ?? false) && (child.nullable ?? false)) return false;
    return typesCompatible(parent.type, child.type);
}

/**
 * Whether `child` is a subtype of `parent` (assignable where the parent is
 * expected). Allows safe narrowing: `number ⊇ integer`, enum value-set subset,
 * array covariance; rejects widening in the other direction.
 */
function typesCompatible(parent: IRType, child: IRType): boolean {
    // Numeric tower: integer is a subtype of number.
    if (parent.kind === "number" && child.kind === "integer") return true;

    if (parent.kind !== child.kind) return false;

    if (parent.kind === "reference" || parent.kind === "embedded") {
        return parent.schema === (child as typeof parent).schema;
    }
    if (parent.kind === "enum" && child.kind === "enum") {
        // Narrowing the allowed set is fine; widening it is not.
        const allowed = new Set(parent.values);
        return child.values.every((v) => allowed.has(v));
    }
    if (parent.kind === "array" && child.kind === "array") {
        // A child cannot make elements nullable when the parent's are not.
        if (!(parent.elementNullable ?? false) && (child.elementNullable ?? false)) return false;
        return typesCompatible(parent.of, child.of);
    }
    if (parent.kind === "integer" && child.kind === "integer") {
        // Signedness must match; the override may only narrow the width
        // (a narrower int fits inside a wider one). Omitted bits => 64.
        if ((parent.unsigned ?? false) !== (child.unsigned ?? false)) return false;
        return (child.bits ?? 64) <= (parent.bits ?? 64);
    }
    if (parent.kind === "number" && child.kind === "number") {
        // The override may only narrow the float width (Float<64> ⊇ Float<32>).
        return (child.bits ?? 64) <= (parent.bits ?? 64);
    }
    return true;
}

/** A short, message-friendly label for a field's type + nullability. */
function fieldLabel(field: IRField): string {
    return field.nullable ? `${irTypeLabel(field.type)} | null` : irTypeLabel(field.type);
}

/** A short human label for an IRType (local — the backend has its own copy). */
function irTypeLabel(type: IRType): string {
    switch (type.kind) {
        case "array": return `${irTypeLabel(type.of)}[]`;
        case "enum": return `enum(${type.values.join("|")})`;
        case "reference": return `Reference<${type.schema}>`;
        case "embedded": return `Embedded<${type.schema}>`;
        default: return type.kind;
    }
}

function mergeIndexes(parentIndexes: IRIndex[], childIndexes: IRIndex[]): IRIndex[] {
    const all = [...parentIndexes, ...childIndexes];
    const seen = new Set<string>();
    return all.filter((idx) => {
        const key = normalizeIndexKey(idx);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function normalizeIndexKey(idx: IRIndex): string {
    const fields = [...idx.fields]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => `${f.name}:${f.direction}`)
        .join(",");
    return `[${fields}]|unique=${idx.unique ?? false}|sparse=${idx.sparse ?? false}`;
}

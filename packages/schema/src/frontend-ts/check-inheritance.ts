import type { IRClassDeclaration, IRField, IRType, IRDiagnostic } from "@keyma/core/ir";
import { inheritedFields } from "@keyma/core/util";
import { mkError, KEYMA032, KEYMA033, KEYMA034 } from "./diagnostics.js";

type InheritanceContext = {
    /** Map from sourceName → extracted schema. */
    schemas: ReadonlyMap<string, IRClassDeclaration>;
    diagnostics: IRDiagnostic[];
};

/**
 * Validate inheritance for all schemas WITHOUT flattening. Inheritance is REAL in the emitted
 * output, so each schema keeps its OWN fields/methods and its `extends` link; the backends emit
 * a genuine base class. This pass only checks the relationships:
 *   - the parent is a @Schema class (KEYMA033),
 *   - a public child does not extend a private parent (KEYMA032),
 *   - each own field that overrides an inherited one is a subtype (KEYMA034).
 * It mutates nothing and returns the same list — the call-site symmetry the old `flattenAll`
 * had (`const schemas = checkInheritance(rawSchemas, ctx)`), minus the field merge.
 */
export function checkInheritance(schemas: IRClassDeclaration[], ctx: InheritanceContext): IRClassDeclaration[] {
    for (const schema of schemas) checkSchema(schema, ctx);
    return schemas;
}

function checkSchema(schema: IRClassDeclaration, ctx: InheritanceContext): void {
    if (schema.extends === undefined) return; // no inheritance, nothing to validate

    const parent = ctx.schemas.get(schema.extends);
    if (parent === undefined) {
        ctx.diagnostics.push(
            mkError(KEYMA033, `"${schema.sourceName}" extends "${schema.extends}" which is not a @Schema class`, schema.source),
        );
        return;
    }

    // KEYMA032: a public child cannot extend a private parent.
    if (schema.visibility === "public" && parent.visibility === "private") {
        ctx.diagnostics.push(
            mkError(KEYMA032, `Public schema "${schema.sourceName}" cannot extend private schema "${schema.extends}"`, schema.source),
        );
    }

    // KEYMA034: each own field that shadows an inherited one must be a subtype, so existing
    // readers of the parent type stay valid. Compare against the nearest ancestor definition.
    const inherited = new Map(inheritedFields(parent, ctx.schemas).map((f) => [f.name, f]));
    for (const f of schema.fields) {
        const parentField = inherited.get(f.name);
        if (parentField !== undefined && !fieldOverrideCompatible(parentField, f)) {
            ctx.diagnostics.push(
                mkError(
                    KEYMA034,
                    `Field "${f.name}" in "${schema.sourceName}" narrows incompatibly: ` +
                    `parent ${fieldLabel(parentField)}, child ${fieldLabel(f)}`,
                    f.source,
                ),
            );
        }
    }
}

/** A child field override must be a subtype of the parent field. */
function fieldOverrideCompatible(parent: IRField, child: IRField): boolean {
    // A child cannot introduce null a parent reader does not expect (widening).
    if (!(parent.nullable ?? false) && (child.nullable ?? false)) return false;
    return typesCompatible(parent.type, child.type);
}

/**
 * Whether `child` is a subtype of `parent` (assignable where the parent is expected). Allows
 * safe narrowing: `number ⊇ integer`, enum value-set subset, array covariance; rejects widening.
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

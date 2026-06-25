import type { IRSchema, IRField, IRFieldIndex, IRIndex, IRValidatorDeclaration, IRFormatterDeclaration } from "@keyma/ir";
import { filterVisibleFields } from "@keyma/compiler-util";
import { mkRaw } from "./emit-literal.js";
import { buildFactoryCall } from "./emit-validators.js";

export type SchemaDataOptions = {
    includePrivate: boolean;
    includeIndexes: boolean;
    formPhasesOnly: boolean;
    /** Validator/formatter declarations keyed by name — for ordering factory-call args. */
    validatorDecls: ReadonlyMap<string, IRValidatorDeclaration>;
    formatterDecls: ReadonlyMap<string, IRFormatterDeclaration>;
    /** Embedded/reference targets this schema needs as a live `refs` dict:
     *  the target's `name` (lookup key) paired with its emitted Python class. */
    refs: readonly { name: string; className: string }[];
    /** Name of the module-level applyDefaults function to reference, if any. */
    applyDefaultsRef?: string;
};

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

/** Build the metadata object for a schema, ready to be emitted with `emitLiteral`. */
export function buildSchemaData(schema: IRSchema, opts: SchemaDataOptions): Record<string, unknown> {
    const fields = filterVisibleFields(schema, opts.includePrivate).map((f) => buildFieldData(f, opts));
    const indexes = opts.includeIndexes ? schema.indexes.map(buildIndexData) : [];

    const out: Record<string, unknown> = {
        name: schema.name,
        sourceName: schema.sourceName,
        fields,
    };
    if (indexes.length > 0) out["indexes"] = indexes;
    if (schema.edge !== undefined) out["edge"] = schema.edge;
    if (schema.visibility === "private") out["visibility"] = "private";
    if (schema.ephemeral) out["ephemeral"] = true;
    if (opts.refs.length > 0) {
        const entries = opts.refs.map((r) => `"${r.name}": ${r.className}`).join(", ");
        out["refs"] = mkRaw(`{${entries}}`);
    }
    if (opts.applyDefaultsRef !== undefined) out["applyDefaults"] = mkRaw(opts.applyDefaultsRef);
    return out;
}

function buildFieldData(field: IRField, opts: SchemaDataOptions): object {
    const formatters = opts.formPhasesOnly
        ? field.formatters.filter((fmt) => CLIENT_PHASES.has(fmt.phase))
        : field.formatters;
    const indexes: IRFieldIndex[] = opts.includeIndexes ? field.indexes : [];

    const base: Record<string, unknown> = { name: field.name, type: field.type };

    if (field.visibility === "private") base["visibility"] = "private";
    if (field.readonly) base["readonly"] = true;
    if (!field.required) base["required"] = false;
    if (field.nullable) base["nullable"] = true;
    if (field.validators.length > 0) {
        base["validators"] = field.validators.map((v) =>
            mkRaw(buildFactoryCall(v.name, v.params, opts.validatorDecls.get(v.name)?.factoryParams ?? [])),
        );
    }
    if (formatters.length > 0) {
        base["formatters"] = formatters.map((fmt) => ({
            phase: fmt.phase,
            fn: mkRaw(buildFactoryCall(fmt.spec.name, fmt.spec.params, opts.formatterDecls.get(fmt.spec.name)?.factoryParams ?? [])),
        }));
    }
    if (indexes.length > 0) base["indexes"] = indexes;
    if (field.ephemeral) base["ephemeral"] = true;
    if (field.default !== undefined && field.default.kind === "literal") base["default"] = field.default;

    return base;
}

function buildIndexData(index: IRIndex): object {
    const out: Record<string, unknown> = { fields: index.fields };
    if (index.unique !== undefined) out["unique"] = index.unique;
    if (index.sparse !== undefined) out["sparse"] = index.sparse;
    if (index.name !== undefined) out["name"] = index.name;
    return out;
}

import type { IRClassDeclaration, IRField } from "@keyma/core/ir";
import { filterVisibleFields } from "@keyma/core/util";
import { mkRaw, buildApplyDefaults, type SchemaDataOptions } from "@keyma/compiler/backend-js";
import { buildFactoryCall } from "./emit-validators.js";
import {
    schemaIndexes, schemaEdge, schemaEphemeral, fieldIndexes, fieldEphemeral, fieldForm,
    fieldValidators, fieldFormatters,
    type IRFieldIndex, type IRIndex,
} from "../ir/extensions.js";

export type { SchemaDataOptions };

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

/**
 * Build the metadata object for a schema, ready to be emitted with `emitLiteral`.
 * Validators/formatters are spliced as live factory calls (`minLength(2)`), `refs`
 * and `applyDefaults` as live code — the object is no longer pure JSON (functions
 * and a Map ride along), so the caller emits it via `emitLiteral`, not JSON.
 */
export function buildSchemaData(schema: IRClassDeclaration, opts: SchemaDataOptions): Record<string, unknown> {
    const fields = filterVisibleFields(schema, opts.includePrivate).map((f) => buildFieldData(f, opts));
    const indexes = opts.includeIndexes ? schemaIndexes(schema).map(buildIndexData) : [];

    const out: Record<string, unknown> = {
        name: schema.name,
        sourceName: schema.sourceName,
        fields,
    };
    // Inheritance is real and metadata carries OWN fields only — a live reference to the parent's
    // `.schema` lets the runtime walk the chain to assemble the full field set. `extends` is the
    // parent's sourceName (the emitted class symbol), so `<Parent>.schema` resolves it.
    if (schema.extends !== undefined) out["base"] = mkRaw(`${schema.extends}.schema`);
    if (indexes.length > 0) out["indexes"] = indexes;
    const edge = schemaEdge(schema);
    if (edge !== undefined) out["edge"] = edge;
    if (schema.visibility === "private") out["visibility"] = "private";
    if (schemaEphemeral(schema)) out["ephemeral"] = true;
    if (opts.refs.length > 0) {
        const entries = opts.refs.map((r) => `[${JSON.stringify(r.name)}, ${r.symbol}]`).join(", ");
        out["refs"] = mkRaw(`new Map([${entries}])`);
    }
    if (opts.includeDefaults) {
        const applyDefaults = buildApplyDefaults(schema, opts.includePrivate);
        if (applyDefaults !== null) out["applyDefaults"] = mkRaw(applyDefaults);
    }
    return out;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function buildFieldData(field: IRField, opts: SchemaDataOptions): object {
    const validators = fieldValidators(field);
    const allFormatters = fieldFormatters(field);
    const formatters = opts.formPhasesOnly
        ? allFormatters.filter((fmt) => CLIENT_PHASES.has(fmt.phase))
        : allFormatters;

    const indexes: IRFieldIndex[] = opts.includeIndexes ? fieldIndexes(field) : [];

    const base: Record<string, unknown> = {
        name: field.name,
        type: field.type,
    };

    if (field.visibility === "private") base["visibility"] = "private";
    if (field.readonly) base["readonly"] = true;
    if (!field.required) base["required"] = false;
    if (field.nullable) base["nullable"] = true;
    if (validators.length > 0) {
        base["validators"] = validators.map((v) =>
            mkRaw(buildFactoryCall(v.name, v.params, opts.functionDecls.get(v.name)?.params ?? [])),
        );
    }
    if (formatters.length > 0) {
        base["formatters"] = formatters.map((fmt) => ({
            phase: fmt.phase,
            fn: mkRaw(buildFactoryCall(fmt.spec.name, fmt.spec.params, opts.functionDecls.get(fmt.spec.name)?.params ?? [])),
        }));
    }
    if (indexes.length > 0) base["indexes"] = indexes;

    if (fieldEphemeral(field)) {
        base["ephemeral"] = true;
    }
    // Only literal defaults ride in the metadata (applied generically by the
    // runtime). Expression defaults are re-emitted as runnable code in the
    // server `defaults.js` registry, so embedding their IR here would be dead
    // data — and would needlessly leak the expression into the client bundle.
    if (field.default !== undefined && field.default.kind === "literal") {
        base["default"] = field.default;
    }
    const form = fieldForm(field);
    if (form !== undefined) {
        base["form"] = form;
    }
    if (field.deprecated !== undefined) {
        base["deprecated"] = field.deprecated;
    }
    // Stable binary wire tag (present only when binary serialization is enabled).
    if (field.tag !== undefined) {
        base["tag"] = field.tag;
    }

    return base;
}

function buildIndexData(index: IRIndex): object {
    const out: Record<string, unknown> = { fields: index.fields };
    if (index.unique !== undefined) out["unique"] = index.unique;
    if (index.sparse !== undefined) out["sparse"] = index.sparse;
    if (index.name !== undefined) out["name"] = index.name;
    return out;
}

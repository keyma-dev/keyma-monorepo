import type { IRClassDeclaration, IRField } from "@keyma/core/ir";
import { filterVisibleFields } from "@keyma/core/util";
import type { CppSchemaData, CppFieldData, SchemaDataOptions } from "@keyma/compiler/backend-cpp";
import { buildFactoryCall } from "./emit-validators.js";
import { schemaIndexes, schemaEphemeral, fieldIndexes, fieldValidators, fieldFormatters } from "../ir/extensions.js";

export type { SchemaDataOptions };

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

/**
 * Build the neutral metadata for a schema's `schema()` accessor: which fields ride, their
 * validator/formatter factory calls, the schema indexes and refs, visibility / ephemeral, and
 * the apply_defaults reference. The compiler's `emitSchemaMeta` renders the span-backed C++
 * `keyma::SchemaMeta` aggregate from this data — so the only C++ this domain still emits is the
 * validator/formatter factory-call fragments (the analogue of the JS model's `mkRaw` calls).
 */
export function buildSchemaData(schema: IRClassDeclaration, opts: SchemaDataOptions): CppSchemaData {
    const fields = filterVisibleFields(schema, opts.includePrivate).map((f) => buildFieldData(f, opts));
    const indexes = (opts.includeIndexes ? schemaIndexes(schema) : []).map((idx) => ({
        fields: idx.fields.map((fld) => fld.name),
        unique: idx.unique === true,
    }));

    const out: CppSchemaData = {
        name: schema.name,
        sourceName: schema.sourceName,
        refs: opts.refs.map((r) => ({ name: r.name, cppClass: r.cppClass })),
        indexes,
        fields,
    };
    if (schema.visibility === "private") out.visibility = "private";
    if (schemaEphemeral(schema)) out.ephemeral = true;
    // Metadata carries OWN fields only — the `.base` accessor lets the runtime walk the chain.
    if (opts.baseClass !== undefined) out.base = opts.baseClass;
    if (opts.applyDefaultsName !== undefined) out.applyDefaults = opts.applyDefaultsName;
    return out;
}

function buildFieldData(field: IRField, opts: SchemaDataOptions): CppFieldData {
    const out: CppFieldData = { name: field.name, type: field.type, required: field.required };
    if (field.nullable === true) out.nullable = true;
    if (field.readonly) out.readonly = true;
    if (field.visibility === "private") out.visibility = "private";
    if (opts.includeIndexes && fieldIndexes(field).length > 0) out.indexed = true;

    const validators = fieldValidators(field);
    if (validators.length > 0) {
        out.validators = validators.map((v) =>
            buildFactoryCall(v.name, v.params, opts.functionDecls.get(v.name)?.params ?? [], opts.functionNamespace(v.name)),
        );
    }
    const allFormatters = fieldFormatters(field);
    const formatters = opts.formPhasesOnly ? allFormatters.filter((fm) => CLIENT_PHASES.has(fm.phase)) : allFormatters;
    if (formatters.length > 0) {
        out.formatters = formatters.map((fm) => ({
            phase: fm.phase,
            fn: buildFactoryCall(fm.spec.name, fm.spec.params, opts.functionDecls.get(fm.spec.name)?.params ?? [], opts.functionNamespace(fm.spec.name)),
        }));
    }
    if (field.tag !== undefined) out.tag = field.tag;
    return out;
}

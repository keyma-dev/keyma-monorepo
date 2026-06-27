import type { IRClassDeclaration, IRMember } from "@keyma/core/ir";
import { filterVisibleFields } from "@keyma/core/util";
import type { CppClassData, CppFieldData, ClassDataOptions } from "@keyma/compiler/backend-cpp";
import { buildFactoryCall } from "./emit-validators.js";
import { schemaIndexes, schemaEphemeral, fieldIndexes, fieldValidators, fieldFormatters } from "../ir/extensions.js";

export type { ClassDataOptions };

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

/** Client bundles omit indexes and keep only form-phase formatters; server/library carry the full set. */
function includeIndexes(bundle: ClassDataOptions["bundle"]): boolean {
    return bundle !== "client";
}
function formPhasesOnly(bundle: ClassDataOptions["bundle"]): boolean {
    return bundle === "client";
}

/**
 * Build the neutral metadata for a class's `metadata()` accessor: which fields ride, their
 * validator/formatter factory calls, the indexes and refs, visibility / ephemeral, and the
 * apply_defaults reference. The compiler's `emitClassMeta` renders the span-backed C++
 * `keyma::ClassMetadata` aggregate from this data — so the only C++ this domain still emits is the
 * validator/formatter factory-call fragments (the analogue of the JS model's `mkRaw` calls).
 */
export function buildClassData(cls: IRClassDeclaration, opts: ClassDataOptions): CppClassData {
    const fields = filterVisibleFields(cls, opts.includePrivate).map((f) => buildFieldData(f, opts));
    const indexes = (includeIndexes(opts.bundle) ? schemaIndexes(cls) : []).map((idx) => ({
        fields: idx.fields.map((fld) => fld.name),
        unique: idx.unique === true,
    }));

    const out: CppClassData = {
        name: cls.name,
        sourceName: cls.sourceName,
        refs: opts.refs.map((r) => ({ name: r.name, cppClass: r.cppClass })),
        indexes,
        fields,
    };
    if (cls.visibility === "private") out.visibility = "private";
    if (schemaEphemeral(cls)) out.ephemeral = true;
    // Metadata carries OWN fields only — the `.base` accessor lets the runtime walk the chain.
    if (opts.baseClass !== undefined) out.base = opts.baseClass;
    if (opts.applyDefaultsName !== undefined) out.applyDefaults = opts.applyDefaultsName;
    return out;
}

function buildFieldData(field: IRMember, opts: ClassDataOptions): CppFieldData {
    const out: CppFieldData = { name: field.name, type: field.type, required: field.required };
    if (field.nullable === true) out.nullable = true;
    if (field.readonly) out.readonly = true;
    if (field.visibility === "private") out.visibility = "private";
    if (includeIndexes(opts.bundle) && fieldIndexes(field).length > 0) out.indexed = true;

    const validators = fieldValidators(field);
    if (validators.length > 0) {
        out.validators = validators.map((v) =>
            buildFactoryCall(v.name, v.params, opts.functionDecls.get(v.name)?.params ?? [], opts.functionNamespace(v.name)),
        );
    }
    const allFormatters = fieldFormatters(field);
    const formatters = formPhasesOnly(opts.bundle) ? allFormatters.filter((fm) => CLIENT_PHASES.has(fm.phase)) : allFormatters;
    if (formatters.length > 0) {
        out.formatters = formatters.map((fm) => ({
            phase: fm.phase,
            fn: buildFactoryCall(fm.spec.name, fm.spec.params, opts.functionDecls.get(fm.spec.name)?.params ?? [], opts.functionNamespace(fm.spec.name)),
        }));
    }
    if (field.tag !== undefined) out.tag = field.tag;
    return out;
}

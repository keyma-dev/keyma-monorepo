import type { IRClassDeclaration, IRMember } from "@keyma/core/ir";
import { filterVisibleFields } from "@keyma/core/util";
import type { CppClassData, CppFieldData, ClassDataOptions } from "@keyma/compiler/backend-cpp";
import { schemaIndexes, schemaEphemeral, fieldIndexes } from "../ir/extensions.js";

export type { ClassDataOptions };

/** Client bundles omit indexes; server/library carry the full set. */
function includeIndexes(bundle: ClassDataOptions["bundle"]): boolean {
    return bundle !== "client";
}

/**
 * Build the neutral metadata for a class's `metadata()` accessor: which fields ride, the indexes
 * and refs, visibility / ephemeral, and the apply_defaults reference. The compiler's
 * `emitClassMeta` renders the span-backed C++ `keyma::ClassMetadata` aggregate from this data.
 *
 * Unlike JS/Python, C++ metadata SHEDS the per-field validators/formatters: the typed B path
 * (the synthesized `validate()`/`format*()` methods over concrete struct members) cannot share a
 * `keyma::Value`-erased `ValidatorFn` with a metadata span, so the C++ validate/format logic lives
 * solely in the methods (plan §2 point 4). The runtime `keyma::validate(metadata(), …)` oracle is
 * therefore unused by generated C++; the parity differential asserts C++-B against the JS oracle.
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
    // Validators/formatters are NOT carried in C++ metadata (the synthesized typed methods own that
    // logic; see the file-level note). Only introspective field data + the binary wire tag ride.
    if (field.tag !== undefined) out.tag = field.tag;
    return out;
}

import type { IRClassDeclaration, IRMember } from "@keyma/core/ir";
import { filterVisibleFields } from "@keyma/core/util";
import { mkRaw, type ClassDataOptions } from "@keyma/compiler/backend-js";
import {
    schemaIndexes, schemaEdge, schemaEphemeral, fieldIndexes, fieldEphemeral, fieldForm,
    type IRFieldIndex, type IRIndex,
} from "../ir/extensions.js";

export type { ClassDataOptions };

/**
 * Build the metadata object for a class, ready to be emitted with `emitLiteral`.
 * The metadata is pure introspective data: behaviour (validate/format/defaults) lives
 * in the synthesized B methods, not here. The only live fragments left are `base`
 * (`Parent.metadata`) and `refs` (a `new Map([...])` of live class references), so the
 * caller still emits the object via `emitLiteral`, not JSON.
 *
 * The bundle gate maps to this domain's index rules: a `client` bundle drops indexes;
 * `server`/`library` keep everything.
 */
export function buildClassData(cls: IRClassDeclaration, opts: ClassDataOptions): Record<string, unknown> {
    const includeIndexes = opts.bundle !== "client";
    const fields = filterVisibleFields(cls, opts.includePrivate).map((f) => buildFieldData(f, opts));
    const indexes = includeIndexes ? schemaIndexes(cls).map(buildIndexData) : [];

    const out: Record<string, unknown> = {
        name: cls.name,
        sourceName: cls.sourceName,
        fields,
    };
    // Inheritance is real and metadata carries OWN fields only — a live reference to the parent's
    // `.metadata` lets the runtime walk the chain to assemble the full field set. `extends` is the
    // parent's sourceName (the emitted class symbol), so `<Parent>.metadata` resolves it.
    if (cls.extends !== undefined) out["base"] = mkRaw(`${cls.extends}.metadata`);
    if (indexes.length > 0) out["indexes"] = indexes;
    const edge = schemaEdge(cls);
    if (edge !== undefined) out["edge"] = edge;
    if (cls.visibility === "private") out["visibility"] = "private";
    if (schemaEphemeral(cls)) out["ephemeral"] = true;
    if (opts.refs.length > 0) {
        const entries = opts.refs.map((r) => `[${JSON.stringify(r.name)}, ${r.symbol}]`).join(", ");
        out["refs"] = mkRaw(`new Map([${entries}])`);
    }
    return out;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function buildFieldData(field: IRMember, opts: ClassDataOptions): object {
    const includeIndexes = opts.bundle !== "client";

    const indexes: IRFieldIndex[] = includeIndexes ? fieldIndexes(field) : [];

    const base: Record<string, unknown> = {
        name: field.name,
        type: field.type,
    };

    if (field.visibility === "private") base["visibility"] = "private";
    if (field.readonly) base["readonly"] = true;
    if (!field.required) base["required"] = false;
    if (field.nullable) base["nullable"] = true;
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

import type { IRClassDeclaration, IRMember } from "@keyma/core/ir";
import { filterVisibleFields } from "@keyma/core/util";
import { mkRaw, factoryIdent, emitLiteral, type ClassDataOptions } from "@keyma/compiler/backend-python";
import {
    schemaIndexes, schemaEdge, schemaEphemeral, fieldIndexes, fieldEphemeral,
    fieldValidators, fieldFormatters,
    type IRFieldIndex, type IRIndex,
} from "../ir/extensions.js";

export type { ClassDataOptions };

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

/** Build the factory call that materializes a validator/formatter in the metadata, e.g.
 *  `min_length(2)`. Field params are ordered positionally by the factory function's parameter list.
 *  The factory itself is now an ordinary (plain) function emitted by the generic backend — the
 *  metadata just calls it (the live callable serves both the A runtime driver and the synthesized
 *  `validate()` method, plan §2.4). */
export function buildFactoryCall(
    name: string,
    params: Record<string, unknown> | undefined,
    factoryParams: readonly { name: string }[],
): string {
    const args = factoryParams.map((p) => params?.[p.name]);
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
    return `${factoryIdent(name)}(${args.map((a) => emitLiteral(a)).join(", ")})`;
}

/** Build the metadata object for a class, ready to be emitted with `emitLiteral`. The schema
 *  domain derives its own index/phase gating from the neutral `bundle`: a client bundle keeps
 *  only form-phase formatters and drops indexes; server/library keep everything. */
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
    // `.metadata` lets the runtime walk the chain for the full field set. `extends` is the parent's
    // sourceName (the emitted class symbol), so `<Parent>.metadata` resolves it.
    if (cls.extends !== undefined) out["base"] = mkRaw(`${cls.extends}.metadata`);
    if (indexes.length > 0) out["indexes"] = indexes;
    const edge = schemaEdge(cls);
    if (edge !== undefined) out["edge"] = edge;
    if (cls.visibility === "private") out["visibility"] = "private";
    if (schemaEphemeral(cls)) out["ephemeral"] = true;
    if (opts.refs.length > 0) {
        const entries = opts.refs.map((r) => `"${r.name}": ${r.className}`).join(", ");
        out["refs"] = mkRaw(`{${entries}}`);
    }
    if (opts.applyDefaultsRef !== undefined) out["applyDefaults"] = mkRaw(opts.applyDefaultsRef);
    return out;
}

function buildFieldData(field: IRMember, opts: ClassDataOptions): object {
    const includeIndexes = opts.bundle !== "client";
    const validators = fieldValidators(field);
    const allFormatters = fieldFormatters(field);
    const formatters = opts.bundle === "client"
        ? allFormatters.filter((fmt) => CLIENT_PHASES.has(fmt.phase))
        : allFormatters;
    const indexes: IRFieldIndex[] = includeIndexes ? fieldIndexes(field) : [];

    const base: Record<string, unknown> = { name: field.name, type: field.type };

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
    if (fieldEphemeral(field)) base["ephemeral"] = true;
    if (field.default !== undefined && field.default.kind === "literal") base["default"] = field.default;
    // Stable binary wire tag (present only when binary serialization is enabled). The dict
    // key stays camelCase — it is the cross-language metadata contract shared with the JS runtime.
    if (field.tag !== undefined) base["tag"] = field.tag;

    return base;
}

function buildIndexData(index: IRIndex): object {
    const out: Record<string, unknown> = { fields: index.fields };
    if (index.unique !== undefined) out["unique"] = index.unique;
    if (index.sparse !== undefined) out["sparse"] = index.sparse;
    if (index.name !== undefined) out["name"] = index.name;
    return out;
}

/**
 * The schema domain's runtime CONTRACT contributions to the compiler — the seams that let the
 * compiler emit the schema's typed validator hot path (the `record`/`optional`/`error.collect`
 * affordances) without any schema-specific backend code:
 *
 *  - `errorCollectIntrinsic` — the variadic `error.collect` op (collect the non-null candidates
 *    into the error list), emitted via the Step-2 domain-intrinsic seam. It is NEVER recognized
 *    from source (`tsName: ""`); synthesis emits it directly.
 *  - `schemaRuntimeSymbols` — the per-language emitted symbols for the schema's runtime-provided
 *    (`external`) types (`ValidationError`, `ValidatorCtx`).
 *  - `schemaRecordLayouts` — the C++ aggregate layouts the typed `record` node lowers to.
 *
 * These are pure data, registered onto the compiler's shared registries by the host
 * (`prepareDomains`). Synthesis (Stage B) emits the IR nodes these describe; until then they are
 * inert (no body emits `record`/`error.collect`/an `external`-typed signature).
 */
import type { IntrinsicDef } from "@keyma/core/ir";
import type { RuntimeSymbols, RecordLayout } from "@keyma/compiler";

/**
 * `error.collect(e0, e1, …)` — collect the non-null candidates into the `ValidationError` list.
 * Free-standing (no receiver); `tsName: ""` keeps it out of source recognition (synthesis-emitted
 * only). The C++ emitter allocates its result vector on the method/lambda allocator threaded via
 * `opts.allocVar`; JS/Python use the bundle-local baked collectors (`__keyma_collect`/
 * `_keyma_collect`).
 */
export const errorCollectIntrinsic: IntrinsicDef = {
    op: "error.collect",
    receiver: "value",
    form: "method",
    tsName: "",
    minArgs: 0,
    maxArgs: 255,
    tier: "required",
    emit: {
        js: (_recv, args) => `__keyma_collect(${args.join(", ")})`,
        python: (_recv, args) => `_keyma_collect(${args.join(", ")})`,
        cpp: (_recv, args, opts) => `keyma::collect_errors(${opts?.allocVar ?? "{}"}, ${args.join(", ")})`,
    },
};

/** Per-language emitted symbols for the schema's runtime-provided (`external`) types. `ValidatorCtx`
 *  is C++-only (it erases to a plain object/dict in JS/Python, so needs no JS/Python symbol). */
export const schemaRuntimeSymbols: Array<readonly [string, RuntimeSymbols]> = [
    ["ValidationError", { js: "ValidationError", python: "ValidationError", cpp: "keyma::ValidationError" }],
    ["ValidatorCtx", { cpp: "keyma::ValidatorCtx" }],
];

/**
 * C++ aggregate layouts for the typed `record` node. `ValidationError` (3× `std::pmr::string`,
 * built on the method allocator) uses designated init in struct-DECLARATION order
 * (`field, code, message`); `ValidatorCtx` (single passthrough field) uses positional CTAD.
 */
export const schemaRecordLayouts: Array<readonly [string, RecordLayout]> = [
    ["ValidationError", {
        fields: [
            { key: "field", ctor: "pmrString" },
            { key: "code", ctor: "pmrString" },
            { key: "message", ctor: "pmrString" },
        ],
        style: "designated",
    }],
    ["ValidatorCtx", {
        fields: [{ key: "object", ctor: "passthrough" }],
        style: "positional",
    }],
];

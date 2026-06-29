import type { IRType, IRDefault, IRClassDeclaration } from "@keyma/core/ir";

/**
 * The neutral, language-agnostic per-class metadata descriptor. A domain pack's class-metadata
 * builder produces ONE of these (pure data, no source fragments); the per-language compiler
 * backends render it into `<Class>.metadata` (JS `Object.freeze({…})`, Python dict, C++
 * `keyma::ClassMetadata` aggregate). This replaces the per-language `buildClassData` outputs
 * (the JS/Python `Record<string,unknown>` with `mkRaw` fragments and the C++ `CppClassData`),
 * moving all language syntax — including the live `base` reference and `refs` collection — into
 * the compiler. The camelCase identity is the cross-language runtime contract.
 *
 * `base` (the parent's `.metadata`) and `refs` (live class references) are deliberately NOT
 * carried here: the compiler derives `base` from `cls.extends` and computes the per-language
 * `refs` symbols itself, since both are emitted code (`Parent.metadata`, a `new Map([...])`,
 * `&Parent::metadata`) that only the language backend can spell.
 */

/** A single-field index entry (schema `@Indexed`), rendered verbatim into JS/Python metadata and
 *  condensed to a boolean `indexed` flag for C++. Matches the schema domain's per-field index shape. */
export type MetadataFieldIndex = {
    unique?: boolean;
    sparse?: boolean;
    direction?: 1 | -1 | "text";
    key?: string;
};

/** A composite (class-level) index. Rendered verbatim into JS/Python metadata; C++ condenses the
 *  `fields` to bare names + a boolean `unique`. Matches the schema domain's class index shape. */
export type MetadataIndex = {
    fields: { name: string; direction: 1 | -1 | "text" }[];
    unique?: boolean;
    sparse?: boolean;
    name?: string;
};

/** One field's neutral metadata. The compiler maps `type` to the per-language type tokens; the
 *  remaining members are introspective data emitted as-is (JS/Python) or selectively (C++). */
export type MetadataFieldDescriptor = {
    name: string;
    /** The field's IR type — the compiler derives the per-language type / element / target tokens. */
    type: IRType;
    /** Private fields ride only in server/library metadata. */
    visibility?: "private";
    readonly?: boolean;
    required: boolean;
    nullable?: boolean;
    /** Per-field indexes (bundle-gated by the builder); non-empty ⇒ the field is indexed. */
    indexes?: MetadataFieldIndex[];
    ephemeral?: boolean;
    /** Literal default carried in the metadata (the builder filters out expression defaults). */
    default?: IRDefault;
    /** UI `@FormField` presentational record (rendered by JS only — ride-through data). */
    form?: unknown;
    /** Deprecation marker — `true` or a reason string (rendered by JS only). */
    deprecated?: boolean | string;
    /** Stable binary wire tag (present only with binary serialization). */
    tag?: number;
};

/** One class's neutral metadata. `base`/`refs` are derived/computed by the compiler renderer. */
export type MetadataClassDescriptor = {
    name: string;
    sourceName: string;
    visibility?: "private";
    ephemeral?: boolean;
    fields: MetadataFieldDescriptor[];
    /** Class-level indexes (bundle-gated by the builder). */
    indexes?: MetadataIndex[];
    /** Edge metadata (graph schemas) — ride-through data rendered by JS/Python only. */
    edge?: unknown;
};

/** Options the compiler passes to a domain's class-metadata builder. Carries only the IR-neutral
 *  visibility/bundle gate; the live `refs`/`base` are computed by the compiler, not the builder. */
export type ClassMetadataOptions = {
    /** Include private members. */
    includePrivate: boolean;
    /** Which bundle is being emitted (the builder gates its own per-bundle metadata off this — e.g.
     *  a `client` bundle drops indexes). */
    bundle: "client" | "server" | "library";
};

/** A live ref the compiler renders into a class's per-language `refs` collection: the target's
 *  identity `name` (the runtime lookup key) paired with its emitted per-language symbol — the JS
 *  class binding, the Python class, or the fully-qualified C++ struct. */
export type MetadataRef = { name: string; target: string };

/**
 * Options the generic per-module emitter passes to a domain's class-metadata builder: the
 * IR-neutral visibility/bundle gate. The live `base`/`refs` are NOT passed — the compiler derives
 * `base` from `cls.extends` and computes the per-language `refs` symbols itself, then renders both.
 * An alias of {@link ClassMetadataOptions} kept for the backend `BuildClassData` surface.
 */
export type ClassDataOptions = ClassMetadataOptions;

/**
 * Builds the per-class neutral {@link MetadataClassDescriptor} the compiler renders into
 * `<Class>.metadata` (JS `Object.freeze({…})`, Python dict, C++ `keyma::ClassMetadata` aggregate).
 * The data-model domain supplies ONE of these as `KeymaDomain.classMetadata`; all three language
 * backends consume it directly. Replaces the deleted per-language `*EmitterPack.buildClassData`.
 */
export type BuildClassData = (cls: IRClassDeclaration, opts: ClassDataOptions) => MetadataClassDescriptor;

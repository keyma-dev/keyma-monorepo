// Schema-domain synthesis: lower a class's validators/formatters into BASE IR methods the
// compiler emits blindly (the "eliminate domain backends" law — domains synthesize base IR; the
// compiler has no concept of "validator"/"formatter"/"phase").
//
// Each class gains:
//   - `validate(): ValidationError[]`     — runs every field's validators, collects errors.
//   - `formatChange/Blur/Submit/Save()`   — applies that phase's formatters in place.
//
// Both are INSTANCE methods over `this` (decision 4/7): the validator/formatter factory
// functions (`minLength`/`trim`) stay emitted as function-valued declarations and these methods
// REFERENCE them, so tree-shaking falls out of the IR call graph. Inheritance is handled by
// FLATTENING — `inheritedFields` yields own + inherited fields (values already live on `this`),
// so no `super` call is needed. Private fields are kept off the client via the `bodyAudience`
// gate (the body differs by bundle; the signature does not). Defaults apply at CONSTRUCTION
// (compiler-owned base codegen), and `metadata` stays compiler-rendered by `buildClassData` — so
// neither is synthesized here.
import type {
    IRClassDeclaration, IRMember, IRMethod, IRExpression, IRStatement,
    IRFunctionDeclaration, IRSourceLocation,
} from "@keyma/core/ir";
import {
    arrayExpr, obj, literal, field, ident, call, intrinsic, record, constDecl, assign, ret, method, external, arrayType,
} from "@keyma/core/ir";
import { inheritedFields } from "@keyma/core/util";
import {
    fieldValidators, fieldFormatters,
    type IRValidator, type IRFormatterSpec, type IRFormatter,
} from "../ir/extensions.js";

/** Inputs the synthesis reads: the lowered factory declarations (for factory-call arg ordering)
 *  and the class set keyed by `sourceName` (for the inheritance/flatten walk). */
export type SynthesizeDeps = {
    functionDecls: ReadonlyMap<string, IRFunctionDeclaration>;
    classesBySourceName: ReadonlyMap<string, IRClassDeclaration>;
};

const SERVER_LIBRARY: ("server" | "library")[] = ["server", "library"];
/** Phases that run client-side (so their bodies must stay private-field-safe on the client). */
const FORM_PHASES: IRFormatter["phase"][] = ["change", "blur", "submit"];

/**
 * Synthesize the schema-domain methods for one class: the `validate`/`format*` instance methods
 * (appended to `cls.methods`). Returns the methods to attach; the caller mutates the class (after
 * name-normalization, so any inheritance-flatten reads the final names).
 */
export function synthesizeClassMembers(
    cls: IRClassDeclaration,
    deps: SynthesizeDeps,
): { methods: IRMethod[] } {
    const methods: IRMethod[] = [];

    const validate = synthesizeValidate(cls, deps);
    if (validate !== null) methods.push(validate);

    for (const fmt of synthesizeFormatters(cls, deps)) methods.push(fmt);

    // Defaults now apply at CONSTRUCTION (`fromValue`/`_hydrate`/`value_traits::from_value` fill an
    // absent field with its default — compiler-owned base codegen, all 3 backends), so no
    // `applyDefaults()` method is synthesized. Metadata stays compiler-rendered by `buildClassData`.
    return { methods };
}

// ─── validate() ────────────────────────────────────────────────────────────────

/**
 * `validate(): ValidationError[]` — builds the typed validator context
 * `ctx = ValidatorCtx{ object: self }`, runs each field's validators as a uniform 3-arg call
 * `factory(args)(this.field, "field", ctx)`, and collects the non-null errors via the
 * `error.collect` intrinsic. Null when the class (own + inherited) has no validators. Private-field
 * checks are gated to server/library via `bodyAudience`; the client body validates only public
 * fields. (Required-presence is a CONSTRUCTION concern, decision 6 — `validate()` is validators-only.)
 */
function synthesizeValidate(cls: IRClassDeclaration, deps: SynthesizeDeps): IRMethod | null {
    const fields = inheritedFields(cls, deps.classesBySourceName);
    const hasAny = fields.some((f) => fieldValidators(f).length > 0);
    if (!hasAny) return null;

    const checksFor = (fs: IRMember[]): IRExpression[] =>
        fs.flatMap((f) => fieldValidators(f).map((v) => validatorCall(f, v, deps)));

    const bodyFor = (fs: IRMember[]): IRStatement[] => {
        const checks = checksFor(fs);
        // error.collect(c0, c1, …) — the variadic "keep the non-null candidates" intrinsic, emitting
        // `__keyma_collect`/`_keyma_collect` (JS/Python) and `keyma::collect_errors` (C++). No ctx
        // when there are no checks (nothing references it).
        if (checks.length === 0) return [ret(intrinsic("error.collect", null, []))];
        return [
            constDecl("ctx", ctxRecord()),
            ret(intrinsic("error.collect", null, checks)),
        ];
    };

    return gatedMethod({
        name: "validate",
        kind: "method",
        returnType: arrayType(external("ValidationError")),
        allFields: fields,
        bodyFor,
        source: cls.source,
    });
}

// ─── formatChange / formatBlur / formatSubmit / formatSave ───────────────────────

/**
 * One `format<Phase>()` instance method per phase that has formatters (own or inherited). Each
 * applies that phase's formatters in place: `this.field = factory(args)(this.field, ctx)`. The
 * client-side phases (change/blur/submit) gate private-field formatting to server/library. The
 * `save` phase is a persistence concern: its whole body is server/library-only with an identity
 * (no-op) client fallback (decision 14), so the method stays present and uniformly named.
 */
function synthesizeFormatters(cls: IRClassDeclaration, deps: SynthesizeDeps): IRMethod[] {
    const fields = inheritedFields(cls, deps.classesBySourceName);
    const out: IRMethod[] = [];

    const phasesPresent = new Set<IRFormatter["phase"]>();
    for (const f of fields) for (const fmt of fieldFormatters(f)) phasesPresent.add(fmt.phase);

    for (const phase of ["change", "blur", "submit", "save"] as const) {
        if (!phasesPresent.has(phase)) continue;

        const bodyFor = (fs: IRMember[]): IRStatement[] => {
            const applies = fs.flatMap((f) =>
                fieldFormatters(f).filter((fmt) => fmt.phase === phase).map((fmt) => formatterApply(f, fmt.spec, deps)),
            );
            if (applies.length === 0) return [];
            return [constDecl("ctx", ctxRecord()), ...applies];
        };

        if (phase === "save") {
            // Persistence phase: real body server/library-only, identity (no-op) on the client.
            out.push(method({
                name: methodNameForPhase(phase),
                kind: "method",
                statements: bodyFor(fields),
                bodyAudience: { audiences: SERVER_LIBRARY, fallback: [] },
                visibility: "public",
                source: cls.source,
            }));
        } else {
            out.push(gatedMethod({
                name: methodNameForPhase(phase),
                kind: "method",
                allFields: fields,
                bodyFor,
                source: cls.source,
            }));
        }
    }
    return out;
}

function methodNameForPhase(phase: IRFormatter["phase"]): string {
    return "format" + phase.charAt(0).toUpperCase() + phase.slice(1);
}

// ─── Shared helpers ──────────────────────────────────────────────────────────────

/** `ValidatorCtx{ object: <self> }` — the typed validator/formatter context carrying the whole
 *  record. The typed `record` node lowers to a plain object/dict in JS/Python and the typed
 *  `keyma::ValidatorCtx{(*this)}` aggregate in C++ (so cross-field reads `ctx.object.<field>` are
 *  member accesses and the allocator is reachable as `ctx.object.get_allocator()`). */
function ctxRecord(): IRExpression {
    return record(external("ValidatorCtx"), { object: intrinsic("self", null, []) });
}

/**
 * Build a method whose body is `bodyFor(allFields)`, gated so the client sees only the public
 * fields when the class has private fields (the body/value differs by audience; the signature
 * does not). When there are no private fields, the body is the same for every audience.
 */
function gatedMethod(opts: {
    name: string;
    kind: IRMethod["kind"];
    returnType?: IRMember["type"];
    allFields: IRMember[];
    bodyFor: (fields: IRMember[]) => IRStatement[];
    source: IRSourceLocation;
}): IRMethod {
    const publicFields = opts.allFields.filter((f) => f.visibility !== "private");
    const full = opts.bodyFor(opts.allFields);
    const hasPrivate = publicFields.length !== opts.allFields.length;

    return method({
        name: opts.name,
        kind: opts.kind,
        ...(opts.returnType !== undefined ? { returnType: opts.returnType } : {}),
        statements: full,
        ...(hasPrivate ? { bodyAudience: { audiences: SERVER_LIBRARY, fallback: opts.bodyFor(publicFields) } } : {}),
        visibility: "public",
        source: opts.source,
    });
}

/**
 * The factory call `factory(args)` for a validator/formatter spec — args ordered positionally by
 * the factory's declared params (trailing absent args dropped), each lowered to an IR literal.
 */
function factoryCall(name: string, params: Record<string, unknown> | undefined, deps: SynthesizeDeps): IRExpression {
    const decl = deps.functionDecls.get(name);
    const ordered = (decl?.params ?? []).map((p) => params?.[p.name]);
    while (ordered.length > 0 && ordered[ordered.length - 1] === undefined) ordered.pop();
    return call(ident(name), ordered.map((a) => (a === undefined ? literal(null) : jsonExpr(a))));
}

/** A validator invocation: always the uniform 3-arg `factory(args)(this.field, "field", ctx)`. The
 *  factory lowering pads every validator inner arrow to `(value, field, ctx)`, so the full arity is
 *  always passable in every backend (no truncation). */
function validatorCall(f: IRMember, v: IRValidator, deps: SynthesizeDeps): IRExpression {
    return call(factoryCall(v.name, v.params, deps), [field(f.name), literal(f.name), ident("ctx")]);
}

/** A formatter application: always the uniform 2-arg `this.field = factory(args)(this.field, ctx)`.
 *  The factory lowering pads every formatter inner arrow to `(value, ctx)`. */
function formatterApply(f: IRMember, spec: IRFormatterSpec, deps: SynthesizeDeps): IRStatement {
    return assign(field(f.name), call(factoryCall(spec.name, spec.params, deps), [field(f.name), ident("ctx")]));
}

/** Lower a plain JSON value (used for metadata data + bound factory args) to an IR expression. */
function jsonExpr(v: unknown): IRExpression {
    if (v === null || v === undefined) return literal(null);
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return literal(v);
    if (Array.isArray(v)) return arrayExpr(v.map(jsonExpr));
    if (typeof v === "object") {
        const props: Record<string, IRExpression> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            if (val !== undefined) props[k] = jsonExpr(val);
        }
        return obj(props);
    }
    // bigint / function / symbol — not expected in schema metadata or factory args.
    return literal(null);
}

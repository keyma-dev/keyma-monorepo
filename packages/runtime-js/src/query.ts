import type { SchemaClass, RecordOf } from "./types.js";
import type {
    KeymaOperation,
    KeymaRequest,
    KeymaLeafResult,
    ProjectionSpec,
    ListOptions,
    Transport,
    TraversalSpec,
    TraversalStep,
    TraversalDirection,
    TraversalEmit,
} from "./protocol.js";
import type { EdgeBrand } from "@keyma/dsl";
import { deserialize } from "./deserialize.js";

// ── Input placeholders ──────────────────────────────────────────────────────

declare const INPUT_BRAND: unique symbol;

export class Input<Name extends string = string> {
    declare readonly [INPUT_BRAND]: true;
    constructor(public readonly name: Name) {}
}

function isInput(v: unknown): v is Input<string> {
    return v instanceof Input;
}

// ── Query operators (MongoDB-style) ─────────────────────────────────────────

export type QueryOp<T> = {
    $eq?: T;
    $ne?: T;
    $gt?: T;
    $gte?: T;
    $lt?: T;
    $lte?: T;
    $in?: T[];
    $nin?: T[];
};

// ── Projection type math ────────────────────────────────────────────────────

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

export type Projection<T> = T extends Primitive
    ? never
    : T extends (infer U)[]
      ? Projection<U>
      : T extends Date
        ? never
        : {
              [K in keyof T]?: T[K] extends Primitive
                  ? 1
                  : T[K] extends Date
                    ? 1
                    : T[K] extends (infer U)[]
                      ? 1 | Projection<U>
                      : 1 | Projection<T[K]>;
          };

export type Projected<T, P> = P extends 1
    ? T
    : T extends (infer U)[]
      ? Projected<U, P>[]
      : T extends Primitive | Date
        ? T
        : {
              [K in keyof P & keyof T]: P[K] extends 1
                  ? T[K]
                  : T[K] extends (infer U)[]
                    ? Projected<U, P[K]>[]
                    : Projected<T[K], P[K]>;
          };

// ── Where / data templates ──────────────────────────────────────────────────

export type WhereArg<T> = {
    [K in keyof T]?: T[K] | QueryOp<T[K]> | Input<string>;
};

export type DataArg<T> = {
    [K in keyof T]?: T[K] | Input<string>;
};

type InputsIn<T, X> = {
    [K in keyof X as X[K] extends Input<infer N> ? N : never]: K extends keyof T
        ? T[K] | QueryOp<T[K]>
        : never;
};

// ── Leaf shapes (type-level only) ───────────────────────────────────────────

declare const LEAF_BRAND: unique symbol;

interface BaseLeaf {
    readonly op: KeymaOperation["op"];
    readonly schemaClass: SchemaClass;
    readonly where?: Record<string, unknown>;
    readonly data?: Record<string, unknown>;
    readonly project?: ProjectionSpec;
}

// R = full record type (for typed sort); I = inputs map; T = output element type
export interface ListLeaf<T, I = {}, R = unknown> extends BaseLeaf {
    readonly op: "list";
    readonly [LEAF_BRAND]: { kind: "list"; out: T[]; inputs: I; record: R };
}

export interface ReadLeaf<T, I> extends BaseLeaf {
    readonly op: "read";
    readonly [LEAF_BRAND]: { kind: "read"; out: T | null; inputs: I };
}

export interface CreateLeaf<T, I> extends BaseLeaf {
    readonly op: "create";
    readonly [LEAF_BRAND]: { kind: "create"; out: T; inputs: I };
}

export interface UpdateLeaf<T, I> extends BaseLeaf {
    readonly op: "update";
    readonly [LEAF_BRAND]: { kind: "update"; out: T; inputs: I };
}

export interface DeleteLeaf<I> extends BaseLeaf {
    readonly op: "delete";
    readonly [LEAF_BRAND]: { kind: "delete"; out: null; inputs: I };
}

export interface TraverseLeaf<T, I = {}, R = unknown> extends BaseLeaf {
    readonly op: "traverse";
    readonly spec: TraversalSpec;
    readonly [LEAF_BRAND]: { kind: "traverse"; out: T[]; inputs: I; record: R };
}

export type AnyLeaf =
    | ListLeaf<unknown, unknown, unknown>
    | ReadLeaf<unknown, unknown>
    | CreateLeaf<unknown, unknown>
    | UpdateLeaf<unknown, unknown>
    | DeleteLeaf<unknown>
    | TraverseLeaf<unknown, unknown, unknown>;

export type QueryLeaf =
    | ListLeaf<unknown, unknown, unknown>
    | ReadLeaf<unknown, unknown>
    | TraverseLeaf<unknown, unknown, unknown>;
export type MutationLeaf =
    | CreateLeaf<unknown, unknown>
    | UpdateLeaf<unknown, unknown>
    | DeleteLeaf<unknown>;

type LeafOut<L> = L extends { readonly [LEAF_BRAND]: { out: infer O } } ? O : never;
type LeafInputs<L> = L extends { readonly [LEAF_BRAND]: { inputs: infer I } } ? I : never;
type LeafRecord<L> = L extends { readonly [LEAF_BRAND]: { record: infer R } } ? R : unknown;

// ── Per-leaf options (first arg to request()) ───────────────────────────────

type TypedListOptions<R> = {
    skip?: number;
    limit?: number;
    sort?: { [K in keyof R]?: 1 | -1 };
};

type LeafOptions<L> = L extends ListLeaf<unknown, unknown, unknown>
    ? TypedListOptions<LeafRecord<L>>
    : L extends TraverseLeaf<unknown, unknown, unknown>
    ? TypedListOptions<LeafRecord<L>>
    : Record<never, never>;

export type RequestLeafOptions<Tmpl extends Record<string, AnyLeaf>> = {
    [K in keyof Tmpl]?: LeafOptions<Tmpl[K]>;
};

// ── Document inputs (second arg to request(), phantom property on documents) ─

// Leaves with no inputs have optional keys; leaves with inputs have required keys.
export type DocumentInputs<Tmpl extends Record<string, AnyLeaf>> =
    { [K in keyof Tmpl as {} extends LeafInputs<Tmpl[K]> ? never : K]: LeafInputs<Tmpl[K]> } &
    { [K in keyof Tmpl as {} extends LeafInputs<Tmpl[K]> ? K : never]?: LeafInputs<Tmpl[K]> };

// ── Results ─────────────────────────────────────────────────────────────────

export type RequestResults<Tmpl extends Record<string, AnyLeaf>> = {
    [K in keyof Tmpl]: KeymaLeafResult<LeafOut<Tmpl[K]>>;
};

export interface RequestResponse<Tmpl extends Record<string, AnyLeaf>> {
    results: RequestResults<Tmpl>;
}

// ── Document interfaces ──────────────────────────────────────────────────────

export interface QueryDocument<Tmpl extends Record<string, QueryLeaf>> {
    /** Phantom type property — use `typeof doc.inputs` to annotate the inputs shape. */
    readonly inputs: DocumentInputs<Tmpl>;
    request(
        options: RequestLeafOptions<Tmpl>,
        opts: { inputs: DocumentInputs<Tmpl>; transport: Transport },
    ): Promise<RequestResponse<Tmpl>>;
}

export interface MutationDocument<Tmpl extends Record<string, MutationLeaf>> {
    /** Phantom type property — use `typeof doc.inputs` to annotate the inputs shape. */
    readonly inputs: DocumentInputs<Tmpl>;
    request(
        options: RequestLeafOptions<Tmpl>,
        opts: { inputs: DocumentInputs<Tmpl>; transport: Transport },
    ): Promise<RequestResponse<Tmpl>>;
}

// ── Runtime implementation ──────────────────────────────────────────────────

function makeDocument<Tmpl extends Record<string, AnyLeaf>>(template: Tmpl): never {
    return {
        async request(
            options: RequestLeafOptions<Tmpl>,
            { inputs, transport }: { inputs: DocumentInputs<Tmpl>; transport: Transport },
        ): Promise<RequestResponse<Tmpl>> {
            const operations: Record<string, KeymaOperation> = {};
            for (const key of Object.keys(template)) {
                const leaf = template[key]!;
                const leafOptions = (options as Record<string, Record<string, unknown>>)[key] ?? {};
                const leafInputs = (inputs as Record<string, Record<string, unknown>>)[key] ?? {};
                operations[key] = buildOperation(leaf, leafOptions, leafInputs);
            }
            const req: KeymaRequest = { operations };
            const response = await transport(req);
            const hydrated: Record<string, KeymaLeafResult> = {};
            for (const [key, result] of Object.entries(response.results)) {
                const leaf = template[key];
                hydrated[key] = leaf === undefined ? result : hydrate(leaf, result);
            }
            return { results: hydrated as RequestResults<Tmpl> };
        },
    } as never;
}

function hydrate(leaf: AnyLeaf, result: KeymaLeafResult): KeymaLeafResult {
    if (!result.ok) return result;
    if (leaf.op === "delete") return result;
    const data = result.data;
    if (data === null || data === undefined) return result;
    const Class = leaf.schemaClass as unknown as new (value?: Record<string, unknown>) => unknown;
    const schema = leaf.schemaClass.schema;
    if (leaf.op === "list" || leaf.op === "traverse") {
        if (!Array.isArray(data)) return result;
        return {
            ok: true,
            data: data.map((r) =>
                isPlainObject(r) ? new Class(deserialize(schema, r)) : r,
            ),
        };
    }
    if (!isPlainObject(data)) return result;
    return { ok: true, data: new Class(deserialize(schema, data)) };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function buildOperation(
    leaf: AnyLeaf,
    leafOptions: Record<string, unknown>,
    leafInputs: Record<string, unknown>,
): KeymaOperation {
    const schemaName = leaf.schemaClass.schema.name;

    switch (leaf.op) {
        case "list": {
            const { skip, limit, sort } = leafOptions as {
                skip?: number;
                limit?: number;
                sort?: Record<string, 1 | -1>;
            };
            const op: KeymaOperation = { op: "list", schema: schemaName };
            if (leaf.where !== undefined) op.where = substitute(leaf.where, leafInputs);
            if (leaf.project !== undefined) op.project = leaf.project;
            const hasOpts = skip !== undefined || limit !== undefined || sort !== undefined;
            if (hasOpts) {
                const options: ListOptions = {};
                if (skip !== undefined) options.skip = skip;
                if (limit !== undefined) options.limit = limit;
                if (sort !== undefined) options.sort = sort;
                op.options = options;
            }
            return op;
        }
        case "read": {
            const op: KeymaOperation = {
                op: "read",
                schema: schemaName,
                where: substitute(leaf.where ?? {}, leafInputs),
            };
            if (leaf.project !== undefined) op.project = leaf.project;
            return op;
        }
        case "create": {
            const op: KeymaOperation = {
                op: "create",
                schema: schemaName,
                data: substitute(leaf.data ?? {}, leafInputs),
            };
            if (leaf.project !== undefined) op.project = leaf.project;
            return op;
        }
        case "update": {
            const op: KeymaOperation = {
                op: "update",
                schema: schemaName,
                where: substitute(leaf.where ?? {}, leafInputs),
                data: substitute(leaf.data ?? {}, leafInputs),
            };
            if (leaf.project !== undefined) op.project = leaf.project;
            return op;
        }
        case "delete": {
            return {
                op: "delete",
                schema: schemaName,
                where: substitute(leaf.where ?? {}, leafInputs),
            };
        }
        case "traverse": {
            const { skip, limit, sort } = leafOptions as {
                skip?: number;
                limit?: number;
                sort?: Record<string, 1 | -1>;
            };
            const spec = substituteSpec(leaf.spec, leafInputs);
            if (skip !== undefined || limit !== undefined || sort !== undefined) {
                const options: ListOptions = {};
                if (skip !== undefined) options.skip = skip;
                if (limit !== undefined) options.limit = limit;
                if (sort !== undefined) options.sort = sort;
                spec.options = options;
            }
            const op: KeymaOperation = { op: "traverse", schema: schemaName, spec };
            if (leaf.project !== undefined) op.project = leaf.project;
            return op;
        }
    }
}

function substituteSpec(
    spec: TraversalSpec,
    leafInputs: Record<string, unknown>,
): TraversalSpec {
    const out: TraversalSpec = {
        start: {
            schema: spec.start.schema,
            where: substitute(spec.start.where, leafInputs),
        },
        emit: spec.emit,
    };
    if (spec.steps !== undefined) {
        out.steps = spec.steps.map((s) => substituteStep(s, leafInputs));
    }
    if (spec.repeat !== undefined) {
        out.repeat = substituteStep(spec.repeat, leafInputs);
    }
    if (spec.depth !== undefined) out.depth = spec.depth;
    if (spec.where !== undefined) out.where = substitute(spec.where, leafInputs);
    return out;
}

function substituteStep(step: TraversalStep, leafInputs: Record<string, unknown>): TraversalStep {
    const out: TraversalStep = { via: step.via, direction: step.direction };
    if (step.edgeWhere !== undefined) out.edgeWhere = substitute(step.edgeWhere, leafInputs);
    if (step.nodeWhere !== undefined) out.nodeWhere = substitute(step.nodeWhere, leafInputs);
    return out;
}

function substitute(
    template: Record<string, unknown>,
    leafInputs: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
        if (isInput(value)) {
            if (!(value.name in leafInputs)) {
                throw new Error(`Missing parameter "${value.name}"`);
            }
            out[key] = leafInputs[value.name];
        } else {
            out[key] = value;
        }
    }
    return out;
}

// ── Leaf builders ───────────────────────────────────────────────────────────

function list<
    C extends SchemaClass,
    W extends WhereArg<RecordOf<C>> = {},
    P extends Projection<RecordOf<C>> | undefined = undefined,
>(
    cls: C,
    where?: W,
    project?: P,
): ListLeaf<
    P extends undefined ? RecordOf<C> : Projected<RecordOf<C>, P>,
    InputsIn<RecordOf<C>, W>,
    RecordOf<C>
> {
    const leaf: BaseLeaf = { op: "list", schemaClass: cls };
    if (where !== undefined) (leaf as { where?: Record<string, unknown> }).where = where as Record<string, unknown>;
    if (project !== undefined) (leaf as { project?: ProjectionSpec }).project = project as ProjectionSpec;
    return leaf as ListLeaf<
        P extends undefined ? RecordOf<C> : Projected<RecordOf<C>, P>,
        InputsIn<RecordOf<C>, W>,
        RecordOf<C>
    >;
}

function read<
    C extends SchemaClass,
    W extends WhereArg<RecordOf<C>>,
    P extends Projection<RecordOf<C>> | undefined = undefined,
>(
    cls: C,
    where: W,
    project?: P,
): ReadLeaf<P extends undefined ? RecordOf<C> : Projected<RecordOf<C>, P>, InputsIn<RecordOf<C>, W>> {
    const leaf: BaseLeaf = {
        op: "read",
        schemaClass: cls,
        where: where as Record<string, unknown>,
    };
    if (project !== undefined) (leaf as { project?: ProjectionSpec }).project = project as ProjectionSpec;
    return leaf as ReadLeaf<
        P extends undefined ? RecordOf<C> : Projected<RecordOf<C>, P>,
        InputsIn<RecordOf<C>, W>
    >;
}

function create<
    C extends SchemaClass,
    D extends DataArg<RecordOf<C>>,
    P extends Projection<RecordOf<C>> | undefined = undefined,
>(
    cls: C,
    data: D,
    project?: P,
): CreateLeaf<
    P extends undefined ? RecordOf<C> : Projected<RecordOf<C>, P>,
    InputsIn<RecordOf<C>, D>
> {
    const leaf: BaseLeaf = {
        op: "create",
        schemaClass: cls,
        data: data as Record<string, unknown>,
    };
    if (project !== undefined) (leaf as { project?: ProjectionSpec }).project = project as ProjectionSpec;
    return leaf as CreateLeaf<
        P extends undefined ? RecordOf<C> : Projected<RecordOf<C>, P>,
        InputsIn<RecordOf<C>, D>
    >;
}

function update<
    C extends SchemaClass,
    W extends WhereArg<RecordOf<C>>,
    D extends DataArg<RecordOf<C>>,
    P extends Projection<RecordOf<C>> | undefined = undefined,
>(
    cls: C,
    where: W,
    data: D,
    project?: P,
): UpdateLeaf<
    P extends undefined ? RecordOf<C> : Projected<RecordOf<C>, P>,
    InputsIn<RecordOf<C>, W> & InputsIn<RecordOf<C>, D>
> {
    const leaf: BaseLeaf = {
        op: "update",
        schemaClass: cls,
        where: where as Record<string, unknown>,
        data: data as Record<string, unknown>,
    };
    if (project !== undefined) (leaf as { project?: ProjectionSpec }).project = project as ProjectionSpec;
    return leaf as UpdateLeaf<
        P extends undefined ? RecordOf<C> : Projected<RecordOf<C>, P>,
        InputsIn<RecordOf<C>, W> & InputsIn<RecordOf<C>, D>
    >;
}

function del<C extends SchemaClass, W extends WhereArg<RecordOf<C>>>(
    cls: C,
    where: W,
): DeleteLeaf<InputsIn<RecordOf<C>, W>> {
    const leaf: BaseLeaf = {
        op: "delete",
        schemaClass: cls,
        where: where as Record<string, unknown>,
    };
    return leaf as DeleteLeaf<InputsIn<RecordOf<C>, W>>;
}

// ── Graph traversal ─────────────────────────────────────────────────────────
//
// A step's `via` is an edge class carrying `EdgeBrand<From, To>`. Given the
// current node type and a direction, `OtherEnd` computes the other endpoint.

type StepInput = {
    via: EdgeBrand<unknown, unknown>;
    direction: TraversalDirection;
    edgeWhere?: Record<string, unknown>;
};

type EdgeFromOf<E> = E extends EdgeBrand<infer F, unknown> ? F : never;
type EdgeToOf<E> = E extends EdgeBrand<unknown, infer T> ? T : never;

type OtherEnd<E, N, D> =
    D extends "out"
        ? EdgeFromOf<E> extends N ? EdgeToOf<E> : never
        : D extends "in"
            ? EdgeToOf<E> extends N ? EdgeFromOf<E> : never
            : D extends "both"
                ? (N extends EdgeFromOf<E> ? EdgeToOf<E> : never)
                  | (N extends EdgeToOf<E> ? EdgeFromOf<E> : never)
                : never;

/** Terminal-node type of a step chain. Yields `never` if any step's endpoints
 *  don't connect to the current node in the requested direction. */
export type TerminalNode<Start, Steps extends readonly StepInput[]> =
    Steps extends readonly [infer Head, ...infer Tail]
        ? Head extends { via: infer V; direction: infer D }
            ? Tail extends readonly StepInput[]
                ? [OtherEnd<V, Start, D>] extends [never]
                    ? never
                    : TerminalNode<OtherEnd<V, Start, D>, Tail>
                : never
            : never
        : Start;

/** Walks a step chain and produces a closed-shape tuple where each step's
 *  `nodeWhere` is typed against the record type of the node that step reaches.
 *  Used directly as the contextual type for `args.steps` so excess-property
 *  checks fire per element. */
type TypedSteps<Cur, Steps extends readonly StepInput[]> =
    Steps extends readonly []
        ? readonly []
        : Steps extends readonly [infer Head, ...infer Tail]
            ? Head extends { via: infer V; direction: infer D }
                ? V extends EdgeBrand<unknown, unknown>
                    ? D extends TraversalDirection
                        ? Tail extends readonly StepInput[]
                            ? readonly [
                                  {
                                      via: V;
                                      direction: D;
                                      edgeWhere?: Record<string, unknown>;
                                      nodeWhere?: WhereArg<OtherEnd<V, Cur, D>>;
                                  },
                                  ...TypedSteps<OtherEnd<V, Cur, D>, Tail>,
                              ]
                            : never
                        : never
                    : never
                : never
            : never;

type StartArg<S extends SchemaClass> = {
    schema: S;
    where: WhereArg<RecordOf<S>>;
};

type TraverseArgsHeterogeneous<
    StartSchema extends SchemaClass,
    Result extends SchemaClass,
    Steps extends readonly StepInput[],
> = {
    start: StartArg<StartSchema>;
    steps: Steps & TypedSteps<RecordOf<StartSchema>, Steps>;
    where?: WhereArg<RecordOf<Result>>;
    emit?: TraversalEmit;
    repeat?: never;
    depth?: never;
};

type TraverseArgsHomogeneous<
    NodeSchema extends SchemaClass,
    Via extends EdgeBrand<unknown, unknown>,
> = {
    start: StartArg<NodeSchema>;
    repeat: {
        via: Via;
        direction: TraversalDirection;
        edgeWhere?: Record<string, unknown>;
    };
    depth: { min?: number; max: number };
    where?: WhereArg<RecordOf<NodeSchema>>;
    emit?: TraversalEmit;
    steps?: never;
};

// Overload 1: heterogeneous chain — start.schema ≠ cls is allowed; chain must connect them.
function traverse<
    StartSchema extends SchemaClass,
    const Steps extends readonly StepInput[],
    Result extends SchemaClass<TerminalNode<RecordOf<StartSchema>, Steps>>,
>(
    cls: Result,
    args: TraverseArgsHeterogeneous<StartSchema, Result, Steps>,
): TraverseLeaf<RecordOf<Result>, {}, RecordOf<Result>>;
// Overload 2: homogeneous repeat — start and terminal share `cls`.
function traverse<
    NodeSchema extends SchemaClass,
    Via extends EdgeBrand<unknown, unknown>,
>(
    cls: NodeSchema,
    args: TraverseArgsHomogeneous<NodeSchema, Via>,
): TraverseLeaf<RecordOf<NodeSchema>, {}, RecordOf<NodeSchema>>;
function traverse(cls: SchemaClass, args: unknown): TraverseLeaf<unknown, {}, unknown> {
    type RawStep = {
        via: SchemaClass;
        direction: TraversalDirection;
        edgeWhere?: Record<string, unknown>;
        nodeWhere?: Record<string, unknown>;
    };
    const a = args as {
        start: { schema: SchemaClass; where: Record<string, unknown> };
        emit?: TraversalEmit;
        steps?: RawStep[];
        repeat?: RawStep;
        depth?: { min?: number; max: number };
        where?: Record<string, unknown>;
    };
    const spec: TraversalSpec = {
        start: { schema: a.start.schema.schema.name, where: a.start.where },
        emit: a.emit ?? "nodes",
    };
    if (a.steps !== undefined) {
        spec.steps = a.steps.map((s) => {
            const step: TraversalStep = { via: s.via.schema.name, direction: s.direction };
            if (s.edgeWhere !== undefined) step.edgeWhere = s.edgeWhere;
            if (s.nodeWhere !== undefined) step.nodeWhere = s.nodeWhere;
            return step;
        });
    }
    if (a.repeat !== undefined) {
        const r: TraversalStep = { via: a.repeat.via.schema.name, direction: a.repeat.direction };
        if (a.repeat.edgeWhere !== undefined) r.edgeWhere = a.repeat.edgeWhere;
        if (a.repeat.nodeWhere !== undefined) r.nodeWhere = a.repeat.nodeWhere;
        spec.repeat = r;
    }
    if (a.depth !== undefined) spec.depth = a.depth;
    if (a.where !== undefined) spec.where = a.where;

    const leaf: BaseLeaf & { spec: TraversalSpec } = {
        op: "traverse",
        schemaClass: cls,
        spec,
    };
    return leaf as TraverseLeaf<unknown, {}, unknown>;
}

function query<Tmpl extends Record<string, QueryLeaf>>(template: Tmpl): QueryDocument<Tmpl> {
    return makeDocument(template) as QueryDocument<Tmpl>;
}

function mutation<Tmpl extends Record<string, MutationLeaf>>(
    template: Tmpl,
): MutationDocument<Tmpl> {
    return makeDocument(template) as MutationDocument<Tmpl>;
}

function input<Name extends string>(name: Name): Input<Name> {
    return new Input(name);
}

export const Keyma = {
    query,
    mutation,
    list,
    read,
    create,
    update,
    delete: del,
    traverse,
    input,
} as const;

// Internal access for the server/client modules
export const __internals = { isInput };

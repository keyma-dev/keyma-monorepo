import type { ValidationError } from "./types.js";
import type { ErrorSource } from "./errors.js";

export type ProjectionSpec = { [key: string]: 1 | ProjectionSpec };

export type ListOptions = {
    skip?: number;
    limit?: number;
    sort?: Record<string, 1 | -1>;
};

export type TraversalDirection = "out" | "in" | "both";
export type TraversalEmit = "nodes" | "edges" | "paths";

export type TraversalStep = {
    /** Edge schema name. */
    via: string;
    direction: TraversalDirection;
    /** Optional filter on edge properties. */
    edgeWhere?: Record<string, unknown>;
    /** Optional filter on the connected node reached via this step. */
    nodeWhere?: Record<string, unknown>;
};

export type TraversalSpec = {
    /** Starting-node schema name and where clause. Independent of the
     *  terminal-node schema, which lives on the operation. */
    start: {
        schema: string;
        where: Record<string, unknown>;
    };
    /** Explicit heterogeneous chain. Mutually exclusive with repeat/depth. */
    steps?: TraversalStep[];
    /** Homogeneous repeat — one step applied 1..N times. */
    repeat?: TraversalStep;
    depth?: { min?: number; max: number };
    /** Filter applied to terminal nodes. */
    where?: Record<string, unknown>;
    /** Output shape. Defaults to "nodes". */
    emit: TraversalEmit;
    /** Pagination/ordering applied to the emitted result set. */
    options?: ListOptions;
};

export type KeymaOperation =
    | {
          op: "list";
          schema: string;
          where?: Record<string, unknown>;
          project?: ProjectionSpec;
          options?: ListOptions;
      }
    | {
          op: "read";
          schema: string;
          where: Record<string, unknown>;
          project?: ProjectionSpec;
      }
    | {
          op: "create";
          schema: string;
          data: Record<string, unknown>;
          project?: ProjectionSpec;
      }
    | {
          op: "update";
          schema: string;
          where: Record<string, unknown>;
          data: Record<string, unknown>;
          project?: ProjectionSpec;
      }
    | {
          op: "delete";
          schema: string;
          where: Record<string, unknown>;
      }
    | {
          op: "traverse";
          /** Terminal-node schema (for hydration). */
          schema: string;
          spec: TraversalSpec;
          project?: ProjectionSpec;
      };

export type KeymaRequest = {
    operations: Record<string, KeymaOperation>;
};

export type KeymaLeafSuccess<T = unknown> = { ok: true; data: T };
export type KeymaLeafFailure = {
    ok: false;
    error: string;
    code: string;
    source: ErrorSource;
    /** Package name of the originator (plugin or adapter). Omitted for runtime errors. */
    origin?: string;
    /** Structured field errors. Present if code === "VALIDATION_FAILED". */
    errors?: ValidationError[];
    /** Free-form extras supplied by the throwing layer (e.g. {fields: [...]} for FIELD_FORBIDDEN). */
    [key: string]: unknown;
};
export type KeymaLeafResult<T = unknown> = KeymaLeafSuccess<T> | KeymaLeafFailure;

export type KeymaBatchResponse = {
    results: Record<string, KeymaLeafResult>;
};

export type Transport = (request: KeymaRequest) => Promise<KeymaBatchResponse>;

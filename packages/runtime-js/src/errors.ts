import type { KeymaLeafFailure } from "./protocol.js";

export type ErrorSource = "runtime" | "plugin" | "adapter";

export abstract class KeymaError extends Error {
    abstract readonly code: string;
    abstract readonly source: ErrorSource;
    /** Package name of the originator, e.g. "@keyma/plugin-acl-js". Empty for runtime. */
    abstract readonly origin: string;
    /** Extra fields merged into the wire failure (e.g. {fields, errors}). */
    toFailureExtras(): Record<string, unknown> {
        return {};
    }
}

export class KeymaRuntimeError extends KeymaError {
    readonly source = "runtime" as const;
    readonly origin = "";
    constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "KeymaRuntimeError";
    }
}

export class KeymaPluginError extends KeymaError {
    readonly source = "plugin" as const;
    private readonly extras: Record<string, unknown>;
    constructor(
        public readonly code: string,
        message: string,
        public readonly origin: string,
        extras: Record<string, unknown> = {},
    ) {
        super(message);
        this.name = "KeymaPluginError";
        this.extras = extras;
    }
    override toFailureExtras(): Record<string, unknown> {
        return this.extras;
    }
}

export class KeymaAdapterError extends KeymaError {
    readonly source = "adapter" as const;
    private readonly extras: Record<string, unknown>;
    constructor(
        public readonly code: string,
        message: string,
        public readonly origin: string,
        extras: Record<string, unknown> = {},
    ) {
        super(message);
        this.name = "KeymaAdapterError";
        this.extras = extras;
    }
    override toFailureExtras(): Record<string, unknown> {
        return this.extras;
    }
}

export function isPluginFailure(r: KeymaLeafFailure): boolean {
    return r.source === "plugin";
}
export function isAdapterFailure(r: KeymaLeafFailure): boolean {
    return r.source === "adapter";
}
export function isRuntimeFailure(r: KeymaLeafFailure): boolean {
    return r.source === "runtime";
}

import type { SchemaMetadata } from "../types.js";

export declare class User {
    static readonly schema: SchemaMetadata;
    readonly id: string;
    firstName: string;
    lastName: string;
    get fullName(): string;
    constructor(value?: { id?: string; firstName?: string; lastName?: string });
}

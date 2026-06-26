import type { SchemaMetadata } from "../types.js";

export declare class User {
    static readonly schema: SchemaMetadata;
    readonly id: string;
    firstName: string;
    lastName: string;
    secretNote: string | undefined;
    get fullName(): string;
    constructor(value?: { id?: string; firstName?: string; lastName?: string; secretNote?: string });
}

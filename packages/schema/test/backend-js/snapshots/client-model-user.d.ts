import type { ClassMetadata } from "../types.js";

export declare class User {
    static readonly metadata: ClassMetadata;
    readonly id: string;
    firstName: string;
    lastName: string;
    get fullName(): string;
    static fromValue(value?: { id?: string; firstName?: string; lastName?: string }): User;
}

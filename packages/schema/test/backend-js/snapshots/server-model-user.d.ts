import type { ClassMetadata, ValidationError } from "../types.js";

export declare class User {
    static readonly metadata: ClassMetadata;
    readonly id: string;
    firstName: string;
    lastName: string;
    secretNote: string | undefined;
    get fullName(): string;
    validate(): ValidationError[];
    formatChange(): void;
    static fromValue(value?: { id?: string; firstName?: string; lastName?: string; secretNote?: string }): User;
}

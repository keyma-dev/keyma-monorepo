import { KeymaAdapterError } from "@keyma/runtime-js";

export const SQLITE_ADAPTER_NAME = "@keyma/adapter-sqlite-js";

export class SqliteAdapterInternal extends KeymaAdapterError {
    constructor(message: string) {
        super("ADAPTER_INTERNAL", message, SQLITE_ADAPTER_NAME);
        this.name = "SqliteAdapterInternal";
    }
}

export class SqliteAdapterInvalidQuery extends KeymaAdapterError {
    constructor(message: string) {
        super("ADAPTER_INVALID_QUERY", message, SQLITE_ADAPTER_NAME);
        this.name = "SqliteAdapterInvalidQuery";
    }
}

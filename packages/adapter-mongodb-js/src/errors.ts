import { KeymaAdapterError } from "@keyma/runtime/schema";

export const MONGO_ADAPTER_NAME = "@keyma/adapter-mongodb-js";

export class MongoAdapterInternal extends KeymaAdapterError {
    constructor(message: string) {
        super("ADAPTER_INTERNAL", message, MONGO_ADAPTER_NAME);
        this.name = "MongoAdapterInternal";
    }
}

export class MongoAdapterInvalidQuery extends KeymaAdapterError {
    constructor(message: string) {
        super("ADAPTER_INVALID_QUERY", message, MONGO_ADAPTER_NAME);
        this.name = "MongoAdapterInvalidQuery";
    }
}

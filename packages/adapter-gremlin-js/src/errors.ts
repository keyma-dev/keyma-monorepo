import { KeymaAdapterError } from "@keyma/runtime/schema";

export const GREMLIN_ADAPTER_NAME = "@keyma/adapter-gremlin-js";

export class GremlinAdapterInternal extends KeymaAdapterError {
    constructor(message: string) {
        super("ADAPTER_INTERNAL", message, GREMLIN_ADAPTER_NAME);
        this.name = "GremlinAdapterInternal";
    }
}

export class GremlinAdapterInvalidQuery extends KeymaAdapterError {
    constructor(message: string) {
        super("ADAPTER_INVALID_QUERY", message, GREMLIN_ADAPTER_NAME);
        this.name = "GremlinAdapterInvalidQuery";
    }
}

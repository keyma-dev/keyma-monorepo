import { KeymaPluginError } from "@keyma/runtime-js";

export const ACL_PLUGIN_NAME = "@keyma/plugin-acl-js";

export class AclDenied extends KeymaPluginError {
    constructor(message: string) {
        super("FORBIDDEN", message, ACL_PLUGIN_NAME);
        this.name = "AclDenied";
    }
}

export class AclFieldForbidden extends KeymaPluginError {
    constructor(public readonly fields: string[]) {
        super(
            "FIELD_FORBIDDEN",
            `Forbidden fields: ${fields.join(", ")}`,
            ACL_PLUGIN_NAME,
            { fields },
        );
        this.name = "AclFieldForbidden";
    }
}

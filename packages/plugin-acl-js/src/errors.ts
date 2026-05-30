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

export class KeymaAclUnknownRole extends KeymaPluginError {
    constructor(public readonly role: string) {
        super(
            "UNKNOWN_ROLE",
            `Unknown role: "${role}". Declare it with admin.addRole("${role}") first.`,
            ACL_PLUGIN_NAME,
            { role },
        );
        this.name = "KeymaAclUnknownRole";
    }
}

export class KeymaAclRoleInUse extends KeymaPluginError {
    constructor(
        public readonly role: string,
        public readonly assignmentIds: string[],
        public readonly ruleIds: string[],
    ) {
        super(
            "ROLE_IN_USE",
            `Role "${role}" is still referenced by ${assignmentIds.length} assignment(s) and ${ruleIds.length} rule(s). Remove those first.`,
            ACL_PLUGIN_NAME,
            { role, assignmentIds, ruleIds },
        );
        this.name = "KeymaAclRoleInUse";
    }
}

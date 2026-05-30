import type { KeymaDatabaseAdapter } from "@keyma/runtime-js";
import {
    ACL_ROLE_ASSIGNMENT_SCHEMA,
    ACL_ROLE_SCHEMA,
    ACL_RULE_SCHEMA,
} from "./schemas.js";
import { KeymaAclRoleInUse, KeymaAclUnknownRole } from "./errors.js";
import { decodeRule } from "./rule-loader.js";
import type { AclRule, AclSubject } from "./types.js";

export type AclRuleInput = Omit<AclRule, "id">;
export type AclRole = { id: string; name: string };
export type AclRoleAssignment = { id: string; userId: string; role: string };

export type ListRulesFilter = {
    schema?: string;
    subject?: AclSubject;
};

export type ListAssignmentsFilter = {
    userId?: string;
    role?: string;
};

export class KeymaAclAdmin {
    constructor(private readonly adapter: KeymaDatabaseAdapter) {}

    // ── Rule management ─────────────────────────────────────────────────

    async addRule(input: AclRuleInput): Promise<AclRule> {
        if (input.subject.kind === "role") {
            await this.assertRoleExists(input.subject.name);
        }
        const row = encodeRule(input);
        const created = await this.adapter.create(ACL_RULE_SCHEMA, row);
        const decoded = decodeRule(created);
        if (decoded === undefined) {
            throw new Error("KeymaAclAdmin.addRule: adapter returned undecodable row");
        }
        return decoded;
    }

    async updateRule(id: string, patch: Partial<AclRuleInput>): Promise<AclRule> {
        const existing = await this.getRule(id);
        if (existing === null) {
            throw new Error(`KeymaAclAdmin.updateRule: rule "${id}" not found`);
        }
        const merged: AclRuleInput = {
            subject: patch.subject ?? existing.subject,
            schema: patch.schema ?? existing.schema,
            actions: patch.actions ?? existing.actions,
            ...(patch.where !== undefined
                ? { where: patch.where }
                : existing.where !== undefined
                  ? { where: existing.where }
                  : {}),
            ...(patch.fields !== undefined
                ? { fields: patch.fields }
                : existing.fields !== undefined
                  ? { fields: existing.fields }
                  : {}),
            ...(patch.effect !== undefined
                ? { effect: patch.effect }
                : existing.effect !== undefined
                  ? { effect: existing.effect }
                  : {}),
            ...(patch.priority !== undefined
                ? { priority: patch.priority }
                : existing.priority !== undefined
                  ? { priority: existing.priority }
                  : {}),
        };
        if (merged.subject.kind === "role") {
            await this.assertRoleExists(merged.subject.name);
        }
        const row = encodeRule(merged);
        const updated = await this.adapter.update(ACL_RULE_SCHEMA, { id }, row);
        const decoded = decodeRule(updated);
        if (decoded === undefined) {
            throw new Error("KeymaAclAdmin.updateRule: adapter returned undecodable row");
        }
        return decoded;
    }

    async removeRule(id: string): Promise<void> {
        await this.adapter.delete(ACL_RULE_SCHEMA, { id });
    }

    async getRule(id: string): Promise<AclRule | null> {
        const rows = await this.adapter.list(ACL_RULE_SCHEMA, {
            where: { id },
            sort: {},
            limit: 1,
        });
        const row = rows[0];
        if (row === undefined) return null;
        return decodeRule(row) ?? null;
    }

    async listRules(filter: ListRulesFilter = {}): Promise<AclRule[]> {
        const where: Record<string, unknown> = {};
        if (filter.schema !== undefined) where["schema"] = filter.schema;
        if (filter.subject !== undefined) {
            where["subjectKind"] = filter.subject.kind;
            if (filter.subject.kind === "user") where["subjectId"] = filter.subject.id;
            if (filter.subject.kind === "role") where["subjectRole"] = filter.subject.name;
        }
        const rows = await this.adapter.list(ACL_RULE_SCHEMA, { where, sort: {} });
        const out: AclRule[] = [];
        for (const row of rows) {
            const decoded = decodeRule(row);
            if (decoded !== undefined) out.push(decoded);
        }
        return out;
    }

    // ── Role management (catalog) ───────────────────────────────────────

    async addRole(name: string): Promise<AclRole> {
        const existing = await this.getRole(name);
        if (existing !== null) return existing;
        const created = await this.adapter.create(ACL_ROLE_SCHEMA, { name });
        return decodeRoleRow(created);
    }

    async removeRole(name: string): Promise<void> {
        const existing = await this.getRole(name);
        if (existing === null) return;
        const [assignments, rules] = await Promise.all([
            this.adapter.list(ACL_ROLE_ASSIGNMENT_SCHEMA, {
                where: { role: name },
                sort: {},
            }),
            this.adapter.list(ACL_RULE_SCHEMA, {
                where: { subjectKind: "role", subjectRole: name },
                sort: {},
            }),
        ]);
        if (assignments.length > 0 || rules.length > 0) {
            throw new KeymaAclRoleInUse(
                name,
                assignments.map((r) => String(r["id"])),
                rules.map((r) => String(r["id"])),
            );
        }
        await this.adapter.delete(ACL_ROLE_SCHEMA, { id: existing.id });
    }

    async getRole(name: string): Promise<AclRole | null> {
        const rows = await this.adapter.list(ACL_ROLE_SCHEMA, {
            where: { name },
            sort: {},
            limit: 1,
        });
        const row = rows[0];
        return row === undefined ? null : decodeRoleRow(row);
    }

    async listRoles(): Promise<AclRole[]> {
        const rows = await this.adapter.list(ACL_ROLE_SCHEMA, { where: {}, sort: {} });
        return rows.map(decodeRoleRow);
    }

    // ── Role assignment management ──────────────────────────────────────

    async assignRole(userId: string, role: string): Promise<AclRoleAssignment> {
        await this.assertRoleExists(role);
        const existing = await this.findAssignment(userId, role);
        if (existing !== null) return existing;
        const created = await this.adapter.create(ACL_ROLE_ASSIGNMENT_SCHEMA, {
            userId,
            role,
        });
        return decodeAssignmentRow(created);
    }

    async unassignRole(userId: string, role: string): Promise<void> {
        await this.adapter.delete(ACL_ROLE_ASSIGNMENT_SCHEMA, { userId, role });
    }

    async getUserRoles(userId: string): Promise<string[]> {
        const rows = await this.adapter.list(ACL_ROLE_ASSIGNMENT_SCHEMA, {
            where: { userId },
            sort: {},
        });
        return rows.map((r) => String(r["role"]));
    }

    async listAssignments(
        filter: ListAssignmentsFilter = {},
    ): Promise<AclRoleAssignment[]> {
        const where: Record<string, unknown> = {};
        if (filter.userId !== undefined) where["userId"] = filter.userId;
        if (filter.role !== undefined) where["role"] = filter.role;
        const rows = await this.adapter.list(ACL_ROLE_ASSIGNMENT_SCHEMA, {
            where,
            sort: {},
        });
        return rows.map(decodeAssignmentRow);
    }

    // ── Internal helpers ────────────────────────────────────────────────

    private async assertRoleExists(name: string): Promise<void> {
        const role = await this.getRole(name);
        if (role === null) throw new KeymaAclUnknownRole(name);
    }

    private async findAssignment(
        userId: string,
        role: string,
    ): Promise<AclRoleAssignment | null> {
        const rows = await this.adapter.list(ACL_ROLE_ASSIGNMENT_SCHEMA, {
            where: { userId, role },
            sort: {},
            limit: 1,
        });
        const row = rows[0];
        return row === undefined ? null : decodeAssignmentRow(row);
    }
}

/** Inverse of `decodeRule` — encodes an in-memory `AclRule` shape to a flat
 *  storage row. Omits `id` so the adapter can assign one on create. */
export function encodeRule(rule: AclRuleInput): Record<string, unknown> {
    const row: Record<string, unknown> = {
        subjectKind: rule.subject.kind,
        schema: rule.schema,
        actions: [...rule.actions],
    };
    if (rule.subject.kind === "user") row["subjectId"] = rule.subject.id;
    if (rule.subject.kind === "role") row["subjectRole"] = rule.subject.name;
    if (rule.where !== undefined) row["where"] = rule.where;
    if (rule.fields?.read !== undefined) row["fieldsRead"] = [...rule.fields.read];
    if (rule.fields?.write !== undefined) row["fieldsWrite"] = [...rule.fields.write];
    if (rule.effect !== undefined) row["effect"] = rule.effect;
    if (rule.priority !== undefined) row["priority"] = rule.priority;
    return row;
}

function decodeRoleRow(row: Record<string, unknown>): AclRole {
    return { id: String(row["id"]), name: String(row["name"]) };
}

function decodeAssignmentRow(row: Record<string, unknown>): AclRoleAssignment {
    return {
        id: String(row["id"]),
        userId: String(row["userId"]),
        role: String(row["role"]),
    };
}

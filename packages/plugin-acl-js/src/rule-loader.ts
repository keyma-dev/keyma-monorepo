import type {
    KeymaAction,
    KeymaDatabaseAdapter,
    RequestContext,
    SchemaMetadata,
} from "@keyma/runtime-js";
import type { AclAction, AclRule, AclSubject } from "./types.js";
import { ACL_ROLE_ASSIGNMENT_SCHEMA, ACL_RULE_SCHEMA } from "./schemas.js";

const CACHE_KEY = "_aclCache";

type Cache = {
    rulesBySubject: Map<string, Promise<AclRule[]>>;
    rolesByUser: Map<string, Promise<Set<string>>>;
};

function getCache(ctx: RequestContext): Cache {
    let cache = ctx[CACHE_KEY] as Cache | undefined;
    if (cache === undefined) {
        cache = {
            rulesBySubject: new Map(),
            rolesByUser: new Map(),
        };
        (ctx as Record<string, unknown>)[CACHE_KEY] = cache;
    }
    return cache;
}

/** Resolve the set of roles for an identity. Caches per-request. */
export async function resolveRoles(
    adapter: KeymaDatabaseAdapter,
    ctx: RequestContext,
): Promise<Set<string>> {
    const explicit = ctx.identity?.roles;
    if (explicit !== undefined) return new Set(explicit);

    const userId = ctx.identity?.id;
    if (userId === undefined) return new Set();

    const cache = getCache(ctx);
    const existing = cache.rolesByUser.get(userId);
    if (existing !== undefined) return existing;

    const p = (async () => {
        const rows = await adapter.list(ACL_ROLE_ASSIGNMENT_SCHEMA, {
            where: { userId },
            sort: {},
        });
        return new Set(rows.map((r) => r["role"] as string));
    })();
    cache.rolesByUser.set(userId, p);
    return p;
}

/** Load all rules applicable to this identity (anon, any-user, the specific
 *  user, and any of their roles). Caches per-request. */
export async function loadRulesFor(
    adapter: KeymaDatabaseAdapter,
    ctx: RequestContext,
): Promise<AclRule[]> {
    const cacheKey = subjectCacheKey(ctx);
    const cache = getCache(ctx);
    const existing = cache.rulesBySubject.get(cacheKey);
    if (existing !== undefined) return existing;

    const p = (async () => {
        const userId = ctx.identity?.id;
        const roles = await resolveRoles(adapter, ctx);

        const queries: Array<Promise<Record<string, unknown>[]>> = [];

        if (userId === undefined) {
            queries.push(
                adapter.list(ACL_RULE_SCHEMA, {
                    where: { subjectKind: "anon" },
                    sort: {},
                }),
            );
        } else {
            queries.push(
                adapter.list(ACL_RULE_SCHEMA, {
                    where: { subjectKind: "any-user" },
                    sort: {},
                }),
                adapter.list(ACL_RULE_SCHEMA, {
                    where: { subjectKind: "user", subjectId: userId },
                    sort: {},
                }),
            );
            for (const role of roles) {
                queries.push(
                    adapter.list(ACL_RULE_SCHEMA, {
                        where: { subjectKind: "role", subjectRole: role },
                        sort: {},
                    }),
                );
            }
        }

        const sets = await Promise.all(queries);
        const out: AclRule[] = [];
        for (const set of sets) {
            for (const row of set) {
                const decoded = decodeRule(row);
                if (decoded !== undefined) out.push(decoded);
            }
        }
        return out;
    })();
    cache.rulesBySubject.set(cacheKey, p);
    return p;
}

/** Map a runtime operation action onto the ACL action vocabulary. The runtime
 *  dispatches `list`, `read`, `traverse`, and `count` as distinct actions, but
 *  they are all reads as far as ACL is concerned, so they collapse to `read`.
 *  Write actions pass through unchanged. */
export function normalizeAction(action: KeymaAction): AclAction {
    if (
        action === "list" ||
        action === "read" ||
        action === "traverse" ||
        action === "count"
    ) {
        return "read";
    }
    return action;
}

/** Pull the rules applicable to a (schema, action) from the full identity set.
 *  The action is normalized to the ACL vocabulary before matching. */
export function filterApplicable(
    rules: ReadonlyArray<AclRule>,
    schemaName: string,
    action: KeymaAction,
): AclRule[] {
    const normalized = normalizeAction(action);
    return rules.filter(
        (r) =>
            (r.schema === "*" || r.schema === schemaName) &&
            r.actions.includes(normalized),
    );
}

function subjectCacheKey(ctx: RequestContext): string {
    const id = ctx.identity?.id ?? "<anon>";
    const roles = ctx.identity?.roles;
    return roles === undefined ? id : `${id}|${[...roles].sort().join(",")}`;
}

/** Decode a stored ACL_RULE row into an AclRule. Returns undefined if the
 *  row is malformed (e.g. missing subjectId for a user-subject rule). */
export function decodeRule(row: Record<string, unknown>): AclRule | undefined {
    const id = row["id"];
    const subjectKind = row["subjectKind"];
    const schema = row["schema"];
    const actions = row["actions"];
    if (typeof id !== "string") return undefined;
    if (typeof subjectKind !== "string") return undefined;
    if (typeof schema !== "string") return undefined;
    if (!Array.isArray(actions)) return undefined;

    let subject: AclSubject;
    switch (subjectKind) {
        case "anon":
            subject = { kind: "anon" };
            break;
        case "any-user":
            subject = { kind: "any-user" };
            break;
        case "user": {
            const subjectId = row["subjectId"];
            if (typeof subjectId !== "string") return undefined;
            subject = { kind: "user", id: subjectId };
            break;
        }
        case "role": {
            const subjectRole = row["subjectRole"];
            if (typeof subjectRole !== "string") return undefined;
            subject = { kind: "role", name: subjectRole };
            break;
        }
        default:
            return undefined;
    }

    const rule: AclRule = {
        id,
        subject,
        schema,
        actions: actions as AclAction[],
    };
    const where = row["where"];
    if (where !== null && typeof where === "object") {
        rule.where = where as Record<string, unknown>;
    }
    const fr = row["fieldsRead"];
    const fw = row["fieldsWrite"];
    if (Array.isArray(fr) || Array.isArray(fw)) {
        rule.fields = {};
        if (Array.isArray(fr)) rule.fields.read = fr as string[];
        if (Array.isArray(fw)) rule.fields.write = fw as string[];
    }
    const effect = row["effect"];
    if (effect === "allow" || effect === "deny") rule.effect = effect;
    const priority = row["priority"];
    if (typeof priority === "number") rule.priority = priority;
    return rule;
}

// Two distinct sets are tracked per (ctx, schema):
//
//   PREDICATE_FIELDS — fields referenced by ACL predicates. We must ensure the
//                      adapter receives these so it can evaluate the predicate.
//                      Stashed by transformFilter; consumed by transformProjection.
//
//   STRIP_FIELDS     — the subset that the plugin actually had to ADD to the
//                      projection (because the caller didn't ask for them).
//                      Only these are stripped by transformResult; fields the
//                      caller explicitly projected stay in the response.

const PREDICATE_FIELDS_KEY = "_aclPredicateFields";
const STRIP_FIELDS_KEY = "_aclStripFields";

function getSchemaSet(
    ctx: RequestContext,
    key: string,
    schema: SchemaMetadata,
): Set<string> {
    let map = ctx[key] as Map<string, Set<string>> | undefined;
    if (map === undefined) {
        map = new Map();
        (ctx as Record<string, unknown>)[key] = map;
    }
    let set = map.get(schema.name);
    if (set === undefined) {
        set = new Set();
        map.set(schema.name, set);
    }
    return set;
}

export function rememberPredicateFields(
    ctx: RequestContext,
    schema: SchemaMetadata,
    fields: ReadonlySet<string>,
): void {
    if (fields.size === 0) return;
    const set = getSchemaSet(ctx, PREDICATE_FIELDS_KEY, schema);
    for (const f of fields) set.add(f);
}

export function getPredicateFields(
    ctx: RequestContext,
    schema: SchemaMetadata,
): Set<string> | undefined {
    const map = ctx[PREDICATE_FIELDS_KEY] as
        | Map<string, Set<string>>
        | undefined;
    return map?.get(schema.name);
}

export function rememberStripFields(
    ctx: RequestContext,
    schema: SchemaMetadata,
    fields: ReadonlySet<string>,
): void {
    if (fields.size === 0) return;
    const set = getSchemaSet(ctx, STRIP_FIELDS_KEY, schema);
    for (const f of fields) set.add(f);
}

export function getStripFields(
    ctx: RequestContext,
    schema: SchemaMetadata,
): Set<string> | undefined {
    const map = ctx[STRIP_FIELDS_KEY] as Map<string, Set<string>> | undefined;
    return map?.get(schema.name);
}

/**
 * Test/reference utilities for `@keyma/runtime/schema`.
 *
 * `InMemoryAdapter` is a fully in-memory {@link KeymaDatabaseAdapter} used by
 * the runtime's own test-suite and by adapter/plugin packages (e.g.
 * `@keyma/plugin-acl-js`). It is the single canonical implementation: it
 * supports the full Mongo-style `where` operator set, field/embedded/populate
 * projections, and native filtered counts.
 *
 * `brandSchema`/`brandService` attach the generated metadata statics
 * (`schema`/`service`) to a hand-written class — used by tests and codegen
 * fallback, where generated bundles instead carry the statics directly.
 *
 * Exposed via the package subpath `@keyma/runtime/schema/testing`.
 */
import type {
    KeymaDatabaseAdapter,
    ListQuery,
    AdapterProjection,
    AdapterFieldSpec,
} from "./adapter.js";
import type {
    SchemaMetadata,
    SchemaClass,
    ServiceMetadata,
    ServiceClass,
} from "./types.js";

export class InMemoryAdapter implements KeymaDatabaseAdapter {
    public stores = new Map<string, Map<string, Record<string, unknown>>>();
    private counter = 0;

    private storeFor(schema: SchemaMetadata): Map<string, Record<string, unknown>> {
        let s = this.stores.get(schema.name);
        if (s === undefined) {
            s = new Map();
            this.stores.set(schema.name, s);
        }
        return s;
    }

    async ensureSchema(schema: SchemaMetadata): Promise<void> {
        this.storeFor(schema);
    }

    async create(
        schema: SchemaMetadata,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>> {
        const store = this.storeFor(schema);
        const id = (data["id"] as string | undefined) ?? `${schema.name}-${++this.counter}`;
        const record = { ...data, id };
        store.set(id, record);
        return projection !== undefined ? this.applyProjection(record, projection) : record;
    }

    async read(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown> | null> {
        const match = [...this.storeFor(schema).values()].find((r) => matches(r, where));
        if (match === undefined) return null;
        return projection !== undefined ? this.applyProjection(match, projection) : match;
    }

    async list(
        schema: SchemaMetadata,
        query: ListQuery,
    ): Promise<Record<string, unknown>[]> {
        let results = [...this.storeFor(schema).values()].filter((r) =>
            matches(r, query.where ?? {}),
        );
        if (query.skip !== undefined) results = results.slice(query.skip);
        if (query.limit !== undefined) results = results.slice(0, query.limit);
        if (query.projection !== undefined) {
            const proj = query.projection;
            results = results.map((r) => this.applyProjection(r, proj));
        }
        return results;
    }

    async update(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>> {
        const store = this.storeFor(schema);
        for (const [id, r] of store.entries()) {
            if (matches(r, where)) {
                const updated = { ...r, ...data, id };
                store.set(id, updated);
                return projection !== undefined
                    ? this.applyProjection(updated, projection)
                    : updated;
            }
        }
        // No existing record matched. When the filter targets a concrete id,
        // upsert under it (insert-or-merge); otherwise the update is undefined.
        if (typeof where["id"] === "string") {
            const id = where["id"];
            const updated = { ...data, id };
            store.set(id, updated);
            return projection !== undefined
                ? this.applyProjection(updated, projection)
                : updated;
        }
        throw new Error(`No record matches where ${JSON.stringify(where)}`);
    }

    async delete(schema: SchemaMetadata, where: Record<string, unknown>): Promise<void> {
        const store = this.storeFor(schema);
        for (const [id, r] of store.entries()) {
            if (matches(r, where)) {
                store.delete(id);
                return;
            }
        }
    }

    async count(schema: SchemaMetadata, where?: Record<string, unknown>): Promise<number> {
        return [...this.storeFor(schema).values()].filter((r) => matches(r, where ?? {}))
            .length;
    }

    private applyProjection(
        record: Record<string, unknown>,
        projection: AdapterProjection,
    ): Record<string, unknown> {
        if (projection.fields === undefined && projection.populate === undefined) {
            return record;
        }
        const result: Record<string, unknown> = {};
        for (const [key, spec] of Object.entries(projection.fields ?? {})) {
            if (spec === 1) {
                result[key] = record[key];
            } else {
                const value = record[key];
                result[key] =
                    typeof value === "object" && value !== null
                        ? this.applyEmbeddedSpec(value as Record<string, unknown>, spec)
                        : null;
            }
        }
        for (const [field, node] of Object.entries(projection.populate ?? {})) {
            const value = record[field];
            if (typeof value !== "string") {
                result[field] = null;
                continue;
            }
            const referenced = this.storeFor(node.schema).get(value) ?? null;
            if (referenced === null) {
                result[field] = null;
            } else if (node.projection !== undefined) {
                result[field] = this.applyProjection(referenced, node.projection);
            } else {
                result[field] = referenced;
            }
        }
        return result;
    }

    private applyEmbeddedSpec(
        value: Record<string, unknown>,
        spec: { [key: string]: AdapterFieldSpec },
    ): Record<string, unknown> {
        const result: Record<string, unknown> = {};
        for (const [key, sub] of Object.entries(spec)) {
            if (sub === 1) {
                result[key] = value[key];
            } else {
                const nested = value[key];
                result[key] =
                    typeof nested === "object" && nested !== null
                        ? this.applyEmbeddedSpec(nested as Record<string, unknown>, sub)
                        : null;
            }
        }
        return result;
    }
}

/** Evaluate a Mongo-style `where` filter against a record. */
export function matches(
    record: Record<string, unknown>,
    where: Record<string, unknown>,
): boolean {
    for (const [key, spec] of Object.entries(where)) {
        if (key === "$and") {
            if (!Array.isArray(spec)) return false;
            for (const sub of spec) {
                if (!matches(record, sub as Record<string, unknown>)) return false;
            }
            continue;
        }
        if (key === "$or") {
            if (!Array.isArray(spec)) return false;
            const any = (spec as Record<string, unknown>[]).some((s) => matches(record, s));
            if (!any) return false;
            continue;
        }
        if (key === "$nor") {
            if (!Array.isArray(spec)) return false;
            const any = (spec as Record<string, unknown>[]).some((s) => matches(record, s));
            if (any) return false;
            continue;
        }
        const fieldValue = record[key];
        if (typeof spec === "object" && spec !== null && !Array.isArray(spec)) {
            const opEntries = Object.entries(spec as Record<string, unknown>);
            const isOpExpr =
                opEntries.length > 0 && opEntries.every(([k]) => k.startsWith("$"));
            if (isOpExpr) {
                for (const [op, arg] of opEntries) {
                    if (!matchesOp(fieldValue, op, arg)) return false;
                }
                continue;
            }
        }
        if (fieldValue !== spec) return false;
    }
    return true;
}

/** Evaluate a single Mongo-style comparison operator. */
export function matchesOp(value: unknown, op: string, arg: unknown): boolean {
    switch (op) {
        case "$eq":
            return value === arg;
        case "$ne":
            return value !== arg;
        case "$in":
            return Array.isArray(arg) && (arg as unknown[]).includes(value);
        case "$nin":
            return Array.isArray(arg) && !(arg as unknown[]).includes(value);
        case "$gt":
            return (value as number) > (arg as number);
        case "$gte":
            return (value as number) >= (arg as number);
        case "$lt":
            return (value as number) < (arg as number);
        case "$lte":
            return (value as number) <= (arg as number);
        default:
            return false;
    }
}

// ── Metadata branding (tests / codegen fallback) ─────────────────────────────
//
// Helpers that attach the generated metadata statics (`schema`/`service`) to a
// plain class. Generated bundles carry these statics directly; hand-written test
// classes brand them on after the fact.

/** Brand a plain class with SchemaMetadata at runtime (tests / codegen fallback). */
export function brandSchema<T>(
    cls: new (value?: Partial<T>) => T,
    schema: SchemaMetadata,
): SchemaClass<T> {
    Object.defineProperty(cls, "schema", {
        value: schema,
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return cls as SchemaClass<T>;
}

/** Brand a plain class with ServiceMetadata at runtime (tests / codegen fallback). */
export function brandService<C extends Function>(
    cls: C,
    service: ServiceMetadata,
): C & ServiceClass {
    Object.defineProperty(cls, "service", {
        value: service,
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return cls as C & ServiceClass;
}

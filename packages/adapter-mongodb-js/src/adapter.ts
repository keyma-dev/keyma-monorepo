import { ObjectId } from "mongodb";
import type { Db } from "mongodb";
import type {
    AdapterCapabilities,
    AdapterProjection,
    AdapterTraversalContext,
    AdapterTraversalResult,
    KeymaDatabaseAdapter,
    ListQuery,
    SchemaMetadata,
    TraversalSpec,
} from "@keyma/runtime-js";
import { translateSort, translateWhere } from "./filter.js";
import { buildIndexes } from "./indexes.js";
import {
    buildAggregationProjection,
    buildLookupStages,
    buildMongoProjection,
    needsAggregation,
    type CollectionNameFn,
} from "./projection.js";
import { fromRecord, toRecord, type SchemaMap } from "./record.js";
import { runTraverse } from "./traverse.js";
import { MongoAdapterInternal } from "./errors.js";

export interface MongoAdapterOptions {
    /** Override how a schema maps to its MongoDB collection name. Defaults to
     *  the schema's `name`. */
    collectionName?: CollectionNameFn;
    /** Override the id generator used when a record is inserted without an
     *  `id`. Defaults to `crypto.randomUUID()`. */
    generateId?: () => string;
}

export class MongoAdapter implements KeymaDatabaseAdapter {
    readonly capabilities: AdapterCapabilities = {
        traverse: { maxDepth: 100, emitPaths: true, heterogeneous: true },
    };

    private readonly schemas = new Map<string, SchemaMetadata>();
    private readonly collectionName: CollectionNameFn;
    private readonly generateId: () => string;

    constructor(private readonly db: Db, opts: MongoAdapterOptions = {}) {
        this.collectionName = opts.collectionName ?? ((s) => s.name);
        this.generateId = opts.generateId ?? (() => new ObjectId().toHexString());
    }

    private register(schema: SchemaMetadata): void {
        this.schemas.set(schema.name, schema);
    }

    private cachedSchemas(): SchemaMap {
        return this.schemas;
    }

    async ensureSchema(schema: SchemaMetadata): Promise<void> {
        this.register(schema);
        const name = this.collectionName(schema);
        try {
            await this.db.createCollection(name);
        } catch (e) {
            // Namespace already exists — idempotent.
            if (
                typeof e === "object" &&
                e !== null &&
                "code" in e &&
                (e as { code?: number }).code !== 48
            ) {
                throw e;
            }
        }
        const indexes = buildIndexes(schema);
        if (indexes.length > 0) {
            await this.db.collection(name).createIndexes(indexes);
        }
    }

    async create(
        schema: SchemaMetadata,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>> {
        this.register(schema);
        const withId = { ...data };
        if (withId["id"] === undefined) withId["id"] = this.generateId();
        const doc = fromRecord(withId, schema, this.cachedSchemas());
        await this.db.collection(this.collectionName(schema)).insertOne(doc);
        const result = await this.fetchOne(schema, { _id: doc["_id"] }, projection);
        if (result === null) throw new MongoAdapterInternal("Created record not found post-insert");
        return result;
    }

    async read(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown> | null> {
        this.register(schema);
        const filter = translateWhere(where, schema, this.cachedSchemas());
        return this.fetchOne(schema, filter, projection);
    }

    async list(
        schema: SchemaMetadata,
        query: ListQuery,
    ): Promise<Record<string, unknown>[]> {
        this.register(schema);
        const schemas = this.cachedSchemas();
        const filter = translateWhere(query.where, schema, schemas);
        const sort = translateSort(query.sort);
        const coll = this.db.collection(this.collectionName(schema));

        if (!needsAggregation(query.projection)) {
            const proj = buildMongoProjection(query.projection?.fields);
            let cursor = proj === undefined
                ? coll.find(filter)
                : coll.find(filter, { projection: proj });
            if (Object.keys(sort).length > 0) cursor = cursor.sort(sort);
            if (query.skip !== undefined) cursor = cursor.skip(query.skip);
            if (query.limit !== undefined) cursor = cursor.limit(query.limit);
            const docs = await cursor.toArray();
            return docs.map((d) => toRecord(d as Record<string, unknown>, schema, schemas));
        }

        const stages: Record<string, unknown>[] = [{ $match: filter }];
        if (Object.keys(sort).length > 0) stages.push({ $sort: sort });
        if (query.skip !== undefined) stages.push({ $skip: query.skip });
        if (query.limit !== undefined) stages.push({ $limit: query.limit });
        stages.push(
            ...buildLookupStages(
                schema,
                query.projection!.populate!,
                schemas,
                this.collectionName,
            ),
        );
        const proj = buildAggregationProjection(
            query.projection?.fields,
            query.projection?.populate,
        );
        if (proj !== undefined) stages.push({ $project: proj });
        const docs = await coll.aggregate(stages).toArray();
        return docs.map((d) => toRecord(d as Record<string, unknown>, schema, schemas));
    }

    async update(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>> {
        this.register(schema);
        const schemas = this.cachedSchemas();
        const filter = translateWhere(where, schema, schemas);
        const set = fromRecord(data, schema, schemas, { excludeId: true });
        const result = await this.db
            .collection(this.collectionName(schema))
            .findOneAndUpdate(
                filter,
                { $set: set },
                { returnDocument: "after" },
            );
        if (result === null) {
            throw new MongoAdapterInternal("Update target not found");
        }
        const fetched = await this.fetchOne(
            schema,
            { _id: (result as Record<string, unknown>)["_id"] },
            projection,
        );
        if (fetched === null) throw new MongoAdapterInternal("Updated record not found post-update");
        return fetched;
    }

    async delete(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
    ): Promise<void> {
        this.register(schema);
        const filter = translateWhere(where, schema, this.cachedSchemas());
        await this.db.collection(this.collectionName(schema)).deleteOne(filter);
    }

    async traverse(
        ctx: AdapterTraversalContext,
        spec: TraversalSpec,
        projection?: AdapterProjection,
    ): Promise<AdapterTraversalResult> {
        for (const s of ctx.edges.values()) this.register(s);
        for (const s of ctx.nodes.values()) this.register(s);
        this.register(ctx.startSchema);
        this.register(ctx.terminalSchema);
        return runTraverse(
            this.db,
            ctx,
            spec,
            projection,
            this.cachedSchemas(),
            this.collectionName,
        );
    }

    private async fetchOne(
        schema: SchemaMetadata,
        filter: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown> | null> {
        const schemas = this.cachedSchemas();
        const coll = this.db.collection(this.collectionName(schema));

        if (!needsAggregation(projection)) {
            const proj = buildMongoProjection(projection?.fields);
            const doc = proj === undefined
                ? await coll.findOne(filter)
                : await coll.findOne(filter, { projection: proj });
            return doc === null ? null : toRecord(doc as Record<string, unknown>, schema, schemas);
        }

        const stages: Record<string, unknown>[] = [{ $match: filter }];
        stages.push(
            ...buildLookupStages(
                schema,
                projection!.populate!,
                schemas,
                this.collectionName,
            ),
        );
        const proj = buildAggregationProjection(
            projection?.fields,
            projection?.populate,
        );
        if (proj !== undefined) stages.push({ $project: proj });
        stages.push({ $limit: 1 });
        const rows = await coll.aggregate(stages).toArray();
        if (rows.length === 0) return null;
        return toRecord(rows[0] as Record<string, unknown>, schema, schemas);
    }
}

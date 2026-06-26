import type {
    AdapterFieldSpec,
    AdapterProjection,
    FieldType,
    PopulateSpec,
    SchemaMetadata,
} from "@keyma/runtime/schema";
import type { SchemaMap } from "./record.js";

export type CollectionNameFn = (schema: SchemaMetadata) => string;

function coreType(type: FieldType): FieldType {
    if (type.kind === "array") return coreType(type.of);
    return type;
}

function isArrayField(type: FieldType): boolean {
    if (type.kind === "array") return true;
    return false;
}

/** Translate AdapterProjection.fields (nested AdapterFieldSpec form) into a
 *  MongoDB nested projection object. Renames `id` → `_id` at the top level.
 *  Explicitly excludes `_id` when the caller didn't ask for `id`. */
export function buildMongoProjection(
    fields: { [key: string]: AdapterFieldSpec } | undefined,
): Record<string, unknown> | undefined {
    if (fields === undefined) return undefined;
    const out = buildProjectionObject(fields, true);
    if (!("_id" in out)) out["_id"] = 0;
    return out;
}

function buildProjectionObject(
    fields: { [key: string]: AdapterFieldSpec },
    top: boolean,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, spec] of Object.entries(fields)) {
        const key = top && k === "id" ? "_id" : k;
        out[key] = spec === 1 ? 1 : buildProjectionObject(spec, false);
    }
    return out;
}

/** Build the final `$project` stage for an aggregation pipeline that has
 *  resolved populate refs via `$lookup`. Includes both projected fields and
 *  populate keys so the lookup results survive. */
export function buildAggregationProjection(
    fields: { [key: string]: AdapterFieldSpec } | undefined,
    populate: PopulateSpec | undefined,
): Record<string, unknown> | undefined {
    // If the caller didn't restrict fields, don't add a $project at all —
    // let everything pass through (populate stages already overwrote the
    // foreign-key values with resolved docs).
    if (fields === undefined) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, spec] of Object.entries(fields)) {
        const key = k === "id" ? "_id" : k;
        out[key] = spec === 1 ? 1 : buildProjectionObject(spec, false);
    }
    if (populate !== undefined) {
        for (const k of Object.keys(populate)) {
            out[k] = 1;
        }
    }
    if (!("_id" in out)) out["_id"] = 0;
    return out;
}

/** Build the `$lookup` + `$set` stages that resolve a populate spec against
 *  the given parent schema. Recursive for nested populate. */
export function buildLookupStages(
    parentSchema: SchemaMetadata,
    populate: PopulateSpec,
    schemas: SchemaMap,
    collectionName: CollectionNameFn,
): Record<string, unknown>[] {
    const stages: Record<string, unknown>[] = [];
    for (const [field, node] of Object.entries(populate)) {
        const meta = parentSchema.fields.find((f) => f.name === field);
        const isArray = meta !== undefined && isArrayField(meta.type);
        const innerPipeline: Record<string, unknown>[] = [];
        if (isArray) {
            innerPipeline.push({
                $match: {
                    $expr: { $in: ["$_id", { $ifNull: ["$$localIds", []] }] },
                },
            });
        } else {
            innerPipeline.push({
                $match: { $expr: { $eq: ["$_id", "$$localId"] } },
            });
        }
        if (node.projection?.populate !== undefined) {
            innerPipeline.push(
                ...buildLookupStages(
                    node.schema,
                    node.projection.populate,
                    schemas,
                    collectionName,
                ),
            );
        }
        const innerProject = buildAggregationProjection(
            node.projection?.fields,
            node.projection?.populate,
        );
        if (innerProject !== undefined) {
            innerPipeline.push({ $project: innerProject });
        }
        stages.push({
            $lookup: {
                from: collectionName(node.schema),
                let: isArray ? { localIds: "$" + field } : { localId: "$" + field },
                pipeline: innerPipeline,
                as: field,
            },
        });
        if (!isArray) {
            stages.push({
                $set: {
                    [field]: {
                        $ifNull: [{ $arrayElemAt: ["$" + field, 0] }, null],
                    },
                },
            });
        }
    }
    return stages;
}

/** Returns true when the projection requires an aggregation pipeline (i.e. has
 *  any populate). Pure-fields projections can use `find()` for efficiency. */
export function needsAggregation(projection: AdapterProjection | undefined): boolean {
    return projection?.populate !== undefined && Object.keys(projection.populate).length > 0;
}

// Re-export so the adapter doesn't need to import FieldType separately.
export { coreType };

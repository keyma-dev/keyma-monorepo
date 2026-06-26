import type { AdapterProjection, SchemaMetadata } from "@keyma/runtime/schema";
import { __, P } from "./gremlin.js";
import type { GraphTraversal } from "./gremlin.js";
import { elementMapToPlain, fromProps, type SchemaMap } from "./props.js";
import { hasPopulate, selectFields } from "./projection.js";

/** A fresh generator of unique, collision-free step labels for the nested
 *  reference sub-traversals within one projected read. */
type LabelGen = () => string;
export function labelGen(): LabelGen {
    let n = 0;
    return () => `__kref_${n++}`;
}

function isArrayField(schema: SchemaMetadata, name: string): boolean {
    const type = schema.fields.find((f) => f.name === name)?.type;
    return type !== undefined && type.kind === "array";
}

/** Extend a traversal positioned at the target element(s) so it emits the full
 *  record AND any populated references in a single server round-trip.
 *
 *  Without populate this is just `valueMap(true)`. With populate it becomes:
 *    project('self', <ref fields…>)
 *      .by(valueMap(true))
 *      .by(<follow ref id → target vertex, recursively projected>)
 *
 *  References are stored as id properties, so each is resolved by reading the
 *  property and matching the target vertex by `T.id` — no per-reference query. */
export function emitProjected(
    trav: GraphTraversal,
    schema: SchemaMetadata,
    projection: AdapterProjection | undefined,
    schemas: SchemaMap,
    gen: LabelGen = labelGen(),
): GraphTraversal {
    if (!hasPopulate(projection)) return trav.valueMap(true);
    const fields = Object.keys(projection!.populate!);
    const edge = schema.edge;
    let p = trav.project("self", ...fields).by(__.valueMap(true));
    for (const field of fields) {
        const node = projection!.populate![field]!;
        if (edge !== undefined && (field === edge.fromField || field === edge.toField)) {
            // Edge endpoints are graph endpoints, not stored properties — hop to
            // the adjacent vertex (out = from, in = to) and project it there.
            const seed = field === edge.fromField ? __.outV() : __.inV();
            p = p.by(emitProjected(seed, node.schema, node.projection, schemas, gen).fold());
        } else {
            p = p.by(refSub(field, node.schema, node.projection, schemas, gen));
        }
    }
    return p;
}

function refSub(
    field: string,
    schema: SchemaMetadata,
    projection: AdapterProjection | undefined,
    schemas: SchemaMap,
    gen: LabelGen,
): GraphTraversal {
    const label = gen();
    // values(field) emits the stored id(s) — one for a scalar reference, many
    // for an array reference — then we hop to the matching target vertex(es).
    const sub = __.values(field).as(label).V().filter(__.id().where(P.eq(label)));
    return emitProjected(sub, schema, projection, schemas, gen).fold();
}

/** Parse a row produced by `emitProjected` back into a Keyma record. Single
 *  references collapse to one record (or null); array references stay arrays.
 *  Recurses for nested populate. */
export function parseProjectedRow(
    row: unknown,
    schema: SchemaMetadata,
    projection: AdapterProjection | undefined,
    schemas: SchemaMap,
): Record<string, unknown> {
    if (!hasPopulate(projection)) {
        return selectFields(fromProps(elementMapToPlain(row), schema, schemas), projection);
    }
    const plain = elementMapToPlain(row);
    const base = fromProps(elementMapToPlain(plain["self"]), schema, schemas);
    for (const [field, node] of Object.entries(projection!.populate!)) {
        const resolved = Array.isArray(plain[field]) ? (plain[field] as unknown[]) : [];
        const parsed = resolved.map((sub) =>
            parseProjectedRow(sub, node.schema, node.projection, schemas),
        );
        base[field] = isArrayField(schema, field) ? parsed : parsed[0] ?? null;
    }
    return selectFields(base, projection);
}

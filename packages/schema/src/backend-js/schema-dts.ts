import type { IRClassDeclaration } from "@keyma/core/ir";
import type { SchemaDtsContext, SchemaDtsShape } from "@keyma/compiler/backend-js";
import { schemaEdge } from "../ir/extensions.js";

/**
 * Schema-domain `.d.ts` shaping. An edge schema cannot be a plain `export declare class`:
 * the public binding `X` must be a branded const carrying the `__edge` phantom (its from/to
 * instance types), so the class itself is privatized to `_X`. Plain (non-edge) schemas return
 * `undefined`, leaving the generic default. This is the schema domain's reader of `edge` for
 * `.d.ts` emission — the generic JS backend no longer knows about edges.
 */
export function shapeSchemaDts(schema: IRClassDeclaration, ctx: SchemaDtsContext): SchemaDtsShape | undefined {
    const edge = schemaEdge(schema);
    if (edge === undefined) return undefined;

    const className = schema.sourceName;
    const declName = `_${className}`;
    // Edge endpoints are identities (`name`); the TS type is the emitted class symbol.
    const fromTs = ctx.embeddedTypeNames.get(edge.from) ?? edge.from;
    const toTs = ctx.embeddedTypeNames.get(edge.to) ?? edge.to;

    return {
        declName,
        declKeyword: "declare class",
        trailer: [
            `export declare const ${className}: typeof ${declName} & { readonly __edge?: { from: ${fromTs}; to: ${toTs} } };`,
            `export type ${className} = InstanceType<typeof ${declName}>;`,
        ],
        importTargets: [edge.from, edge.to],
    };
}

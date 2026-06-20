import { EMITTED_RUNTIME_TYPES_DTS } from "./emitted-runtime-types.js";

/** Bundle-relative module ref of the inlined types module (sits at the bundle root). */
export const TYPES_REF = "types";

/**
 * The runtime `types.js` — a value-less module so `import type … from "./types.js"`
 * resolves under NodeNext. The type declarations live entirely in `types.d.ts`.
 */
export function emitTypesJs(): string {
    return "export {};\n";
}

/**
 * The inlined, dependency-free `types.d.ts` — a verbatim copy of `@keyma/runtime-js`'s
 * pure type declarations (`SchemaMetadata`, `ValidatorFn`, `ServiceMetadata`,
 * `RequestContext`, …). Generated bundles import their type surface from here
 * instead of `@keyma/runtime-js`.
 */
export function emitTypesDts(): string {
    return EMITTED_RUNTIME_TYPES_DTS;
}

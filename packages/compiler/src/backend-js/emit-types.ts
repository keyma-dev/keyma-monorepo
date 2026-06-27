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
 * The inlined, dependency-free `types.d.ts` — the compiler-owned service/request type
 * surface (`ServiceMetadata`, `RequestContext`, …) plus any domain-supplied declaration
 * blocks (`extraDecls`, e.g. a data-model domain's `ClassMetadata`). Generated bundles
 * import their type surface from here instead of from a runtime package.
 */
export function emitTypesDts(extraDecls: readonly string[]): string {
    return [EMITTED_RUNTIME_TYPES_DTS, ...extraDecls].join("\n");
}

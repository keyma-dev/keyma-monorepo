import type { KeymaDomain } from "@keyma/compiler";
import { schemaFrontendDomain } from "./frontend-ts/index.js";
import { schemaIRValidator } from "./ir/index.js";
import { buildClassMetadata } from "./metadata-descriptor.js";
import { EMITTED_SCHEMA_TYPES_DTS } from "./emitted-runtime-types.js";
import { errorCollectIntrinsic, schemaRuntimeSymbols, schemaRecordLayouts } from "./runtime-contract.js";

export { errorCollectIntrinsic, schemaRuntimeSymbols, schemaRecordLayouts } from "./runtime-contract.js";
// The neutral class-metadata descriptor builder + the JS `.d.ts` type-surface blob, exported
// from the package root so direct consumers and test harnesses can wire the backends themselves.
export { buildClassMetadata } from "./metadata-descriptor.js";
export { EMITTED_SCHEMA_TYPES_DTS } from "./emitted-runtime-types.js";

/**
 * The schema domain, wired across the extension seams of a domain-neutral `@keyma/compiler`.
 * This is the package-root descriptor the CLI loads (one well-known export, `keymaDomain`) and
 * registers — DSL recognition flows through the frontend domain, IR section checks through
 * `irValidator`, and emission through TWO neutral, language-agnostic hooks:
 *
 *  - `classMetadata`    → the per-class metadata-descriptor builder every backend renders into
 *                         `<Class>.metadata` (no per-language code; the compiler owns the syntax)
 *  - `runtimeTypeDecls` → the JS `ClassMetadata`/`ValidationError`/… `.d.ts` type surface the JS
 *                         backend appends to each bundle's `types.d.ts`
 *
 * The individual seam exports remain available under their own subpaths
 * (`@keyma/schema/frontend-ts`, `/ir`, …) for direct/browser/SSR consumers; this aggregator is
 * purely additive.
 */
export const keymaDomain: KeymaDomain = {
    name: "schema",
    frontend: schemaFrontendDomain,
    irValidator: schemaIRValidator,
    classMetadata: buildClassMetadata,
    runtimeTypeDecls: () => EMITTED_SCHEMA_TYPES_DTS,
    // The typed-validator hot path contract (the `record`/`optional`/`error.collect` affordances).
    // Inert until synthesis (Stage B) emits these nodes; registered now so the wiring is in place.
    intrinsics: [errorCollectIntrinsic],
    runtimeSymbols: schemaRuntimeSymbols,
    recordLayouts: schemaRecordLayouts,
};

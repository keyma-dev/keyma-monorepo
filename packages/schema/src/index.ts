import type { KeymaDomain } from "@keyma/compiler";
import { schemaFrontendDomain } from "./frontend-ts/index.js";
import { schemaIRValidator } from "./ir/index.js";
import { schemaJsEmitterPack } from "./backend-js/index.js";
import { schemaPythonEmitterPack } from "./backend-python/index.js";
import { schemaCppEmitterPack } from "./backend-cpp/index.js";

/**
 * The schema domain, wired across all four extension seams of a domain-neutral
 * `@keyma/compiler`. This is the package-root descriptor the CLI loads (one well-known
 * export, `keymaDomain`) and registers — DSL recognition flows through the frontend domain,
 * IR section checks through `irValidator`, and per-language emission through `emitterPacks`.
 *
 * The individual seam exports remain available under their own subpaths
 * (`@keyma/schema/frontend-ts`, `/ir`, `/backend-js`, …) for direct/browser/SSR consumers
 * that assemble the pipeline themselves; this aggregator is purely additive.
 */
export const keymaDomain: KeymaDomain = {
    name: "schema",
    frontend: schemaFrontendDomain,
    irValidator: schemaIRValidator,
    emitterPacks: {
        js: schemaJsEmitterPack,
        python: schemaPythonEmitterPack,
        cpp: schemaCppEmitterPack,
    },
};

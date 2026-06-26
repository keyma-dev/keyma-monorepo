import type { KeymaDomain } from "@keyma/compiler";
import { uiFrontendDomain } from "./frontend-ts/index.js";
import { uiJsEmitterPack } from "./backend-js/index.js";
import { uiPythonEmitterPack } from "./backend-python/index.js";
import { uiCppEmitterPack } from "./backend-cpp/index.js";

// The UI domain's IR contract (the `extensions['ui']` shape), re-exported for consumers.
export * from "./extension.js";

/**
 * The UI domain, wired across the extension seams of a domain-neutral `@keyma/compiler`. This
 * is the package-root descriptor the CLI auto-detects (it is already listed in the CLI's
 * `KNOWN_DOMAIN_PACKAGES`) and reads as one well-known export — DSL recognition flows through
 * the frontend domain, and per-language emission through `emitterPacks`. No `irValidator` is
 * needed: the UI slice rides in `ir.extensions['ui']`, which the core IR checks already
 * tolerate (any object), so the domain adds no IR section validator.
 *
 * Adding this package is purely additive: `@keyma/compiler` imports no UI symbol, and the
 * individual seams stay available under their own subpaths (`@keyma/ui/frontend-ts`, etc.).
 */
export const keymaDomain: KeymaDomain = {
    name: "ui",
    frontend: uiFrontendDomain,
    emitterPacks: {
        js: uiJsEmitterPack,
        python: uiPythonEmitterPack,
        cpp: uiCppEmitterPack,
    },
};

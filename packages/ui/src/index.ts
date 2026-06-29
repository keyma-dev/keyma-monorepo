import type { KeymaDomain } from "@keyma/compiler";
import { uiFrontendDomain } from "./frontend-ts/index.js";

// The UI domain's authoring vocabulary + per-class view shapes, re-exported for consumers.
export * from "./extension.js";

/**
 * The UI domain — FRONTEND-ONLY. It is the package-root descriptor the CLI auto-detects
 * (listed in the CLI's `KNOWN_DOMAIN_PACKAGES`): the `@UiView`/`@Widget` decorators are recognized
 * by the frontend domain, which synthesizes a per-class `view` STATIC member that the compiler's
 * generic static-member emission renders blindly. The domain ships zero backend code — no
 * `classMetadata`, no `runtimeTypeDecls` — which is the thesis of "eliminate domain backends".
 * Adding this package stays purely additive: `@keyma/compiler` imports no UI symbol.
 */
export const keymaDomain: KeymaDomain = {
    name: "ui",
    frontend: uiFrontendDomain,
};

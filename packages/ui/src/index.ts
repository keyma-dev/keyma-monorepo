import type { KeymaDomain } from "@keyma/compiler";
import { uiFrontendDomain } from "./frontend-ts/index.js";

// The UI domain's authoring vocabulary + per-class view shapes, re-exported for consumers.
export * from "./extension.js";

/**
 * The UI domain — now FRONTEND-ONLY. It is the package-root descriptor the CLI auto-detects
 * (listed in the CLI's `KNOWN_DOMAIN_PACKAGES`): the `@UiView`/`@Widget` decorators are recognized
 * by the frontend domain, which synthesizes a per-class `view` STATIC member that the compiler's
 * generic static-member emission renders blindly. There are NO per-language emitter packs anymore —
 * the domain ships zero backend code (the thesis of "eliminate domain backends").
 *
 * `emitterPacks` is `{}` because `KeymaDomain.emitterPacks` is still a required field at this stage
 * (the registry/`emitterPacks` machinery is removed in the later T-machinery stage); an empty map
 * means this domain contributes no per-language pack — the registry's `emitBundleFiles` loop simply
 * finds none. Adding this package stays purely additive: `@keyma/compiler` imports no UI symbol.
 */
export const keymaDomain: KeymaDomain = {
    name: "ui",
    frontend: uiFrontendDomain,
    emitterPacks: {},
};

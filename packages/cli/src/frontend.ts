import { compile } from "@keyma/compiler-frontend-ts";
import type { KeymaFrontend, ResolvedConfig } from "@keyma/compiler";
import { resolveSources } from "./sources.js";

/**
 * Adapts `@keyma/compiler-frontend-ts`'s synchronous `compile()` to the async
 * `KeymaFrontend` plugin shape expected by the driver. Source patterns in the
 * resolved config are globbed relative to `cwd`.
 */
export function createTsFrontend(cwd: string): KeymaFrontend {
    return {
        name: "@keyma/compiler-frontend-ts",
        sourceExtensions: [".ts"],
        async compile(config: ResolvedConfig) {
            const files = await resolveSources(config.source, cwd);
            return compile({
                files,
                ...(config.baseDir !== undefined ? { baseDir: config.baseDir } : {}),
                schemaPrefix: config.schemaPrefix,
                // Binary tag manifest: forwarded as data (the CLI did the file I/O). The pure
                // compile() runs the assignTags pass and returns the updated manifest.
                ...(config.binary === true ? { binaryTags: true } : {}),
                ...(config.tagManifest !== undefined ? { tagManifest: config.tagManifest } : {}),
                ...(config.acceptTags === true ? { acceptTags: true } : {}),
            });
        },
    };
}

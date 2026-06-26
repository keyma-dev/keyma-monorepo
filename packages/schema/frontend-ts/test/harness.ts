// Test harness: the schema frontend tests drive `@keyma/compiler/frontend-ts`'s generic
// `compile`/`compileVirtual`, which now require the consumer to register frontend domains.
// These thin wrappers inject the schema domain (exactly as the CLI does) so the test call
// sites stay identical to the pre-carve API. Pass an explicit `domains` to override.
import {
    compile as baseCompile,
    compileVirtual as baseCompileVirtual,
    type FrontendConfig,
    type CompileResult,
} from "@keyma/compiler/frontend-ts";
import { schemaFrontendDomain } from "../src/index.js";

export function compile(config: FrontendConfig): CompileResult {
    return baseCompile({ domains: [schemaFrontendDomain], ...config });
}

export function compileVirtual(
    virtualSources: Record<string, string>,
    config: Omit<FrontendConfig, "files"> & { baseDir?: string },
): CompileResult {
    return baseCompileVirtual(virtualSources, { domains: [schemaFrontendDomain], ...config });
}

export type { CompileResult, FrontendConfig };

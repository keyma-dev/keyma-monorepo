// Test harness: the C++ backend's `emitCpp` now takes neutral `CppBackendOptions`. This wrapper
// pre-binds the schema domain's `classMetadata` builder (as the CLI does) so the test call sites
// stay identical to the pre-carve `emitCpp(ir, target, config)` API; `cppBackend` is the assembled
// backend the metadata test inspects.
import { emitCpp as baseEmitCpp, createCppBackend } from "@keyma/compiler/backend-cpp";
import { defaultRuntimeSymbols, defaultRecordLayouts } from "@keyma/compiler";
import type { KeymaTargetConfig, ResolvedConfig, EmitResult, KeymaBackend } from "@keyma/compiler";
import { defaultIntrinsics } from "@keyma/core/ir";
import type { KeymaIR } from "@keyma/core/ir";
import { buildClassMetadata } from "../../src/metadata-descriptor.js";
import { errorCollectIntrinsic, schemaRuntimeSymbols, schemaRecordLayouts } from "../../src/runtime-contract.js";
import { withSchemaSynthesis } from "../synthesis-harness.js";

// Register the schema runtime contract (as `prepareDomains` does for the CLI) so the synthesized
// methods' `error.collect`/`record(ValidatorCtx)` nodes emit their C++ forms.
defaultIntrinsics.register(errorCollectIntrinsic);
defaultRuntimeSymbols.registerAll(schemaRuntimeSymbols);
defaultRecordLayouts.registerAll(schemaRecordLayouts);

const cppOpts = { classMetadata: buildClassMetadata };

export const cppBackend: KeymaBackend = createCppBackend(cppOpts);

export function emitCpp(ir: KeymaIR, target: KeymaTargetConfig, config: ResolvedConfig): Promise<EmitResult> {
    return baseEmitCpp(withSchemaSynthesis(ir), target, config, cppOpts);
}

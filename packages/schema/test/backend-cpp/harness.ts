// Test harness: the C++ backend's `emitCpp` now takes an `EmitterRegistry` of domain packs.
// This wrapper pre-registers the schema pack (as the CLI does) so the test call sites stay
// identical to the pre-carve `emitCpp(ir, target, config)` API; `cppBackend` is the assembled
// backend the metadata test inspects.
import { emitCpp as baseEmitCpp, createCppBackend, EmitterRegistry } from "@keyma/compiler/backend-cpp";
import { defaultRuntimeSymbols, defaultRecordLayouts } from "@keyma/compiler";
import type { KeymaTargetConfig, ResolvedConfig, EmitResult, KeymaBackend } from "@keyma/compiler";
import { defaultIntrinsics } from "@keyma/core/ir";
import type { KeymaIR } from "@keyma/core/ir";
import { schemaCppEmitterPack } from "../../src/backend-cpp/index.js";
import { errorCollectIntrinsic, schemaRuntimeSymbols, schemaRecordLayouts } from "../../src/runtime-contract.js";
import { withSchemaSynthesis } from "../synthesis-harness.js";

// Register the schema runtime contract (as `prepareDomains` does for the CLI) so the synthesized
// methods' `error.collect`/`record(ValidatorCtx)` nodes emit their C++ forms.
defaultIntrinsics.register(errorCollectIntrinsic);
defaultRuntimeSymbols.registerAll(schemaRuntimeSymbols);
defaultRecordLayouts.registerAll(schemaRecordLayouts);

const registry = new EmitterRegistry();
registry.register(schemaCppEmitterPack);

export const cppBackend: KeymaBackend = createCppBackend([schemaCppEmitterPack]);

export function emitCpp(ir: KeymaIR, target: KeymaTargetConfig, config: ResolvedConfig): Promise<EmitResult> {
    return baseEmitCpp(withSchemaSynthesis(ir), target, config, registry);
}

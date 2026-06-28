// Test harness: the JS backend's `emitJs` now takes an `EmitterRegistry` of domain packs.
// This wrapper pre-registers the schema pack (exactly as the CLI does) so the backend test
// call sites stay identical to the pre-carve `emitJs(ir, target, config)` API.
import { emitJs as baseEmitJs, EmitterRegistry } from "@keyma/compiler/backend-js";
import { defaultRuntimeSymbols, defaultRecordLayouts } from "@keyma/compiler";
import type { KeymaTargetConfig, ResolvedConfig, EmitResult } from "@keyma/compiler";
import { defaultIntrinsics } from "@keyma/core/ir";
import type { KeymaIR } from "@keyma/core/ir";
import { schemaJsEmitterPack } from "../../src/backend-js/index.js";
import { errorCollectIntrinsic, schemaRuntimeSymbols, schemaRecordLayouts } from "../../src/runtime-contract.js";
import { withSchemaSynthesis } from "../synthesis-harness.js";

// Register the schema domain's runtime contract (the `error.collect` intrinsic + runtime type
// symbols + C++ record layouts) onto the compiler's shared registries, exactly as `prepareDomains`
// does for the CLI, so the synthesized `validate()` body's `error.collect`/`record` nodes emit.
defaultIntrinsics.register(errorCollectIntrinsic);
defaultRuntimeSymbols.registerAll(schemaRuntimeSymbols);
defaultRecordLayouts.registerAll(schemaRecordLayouts);

const registry = new EmitterRegistry();
registry.register(schemaJsEmitterPack);

export function emitJs(ir: KeymaIR, target: KeymaTargetConfig, config: ResolvedConfig): Promise<EmitResult> {
    return baseEmitJs(withSchemaSynthesis(ir), target, config, registry);
}

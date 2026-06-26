// Test harness: the C++ backend's `emitCpp` now takes an `EmitterRegistry` of domain packs.
// This wrapper pre-registers the schema pack (as the CLI does) so the test call sites stay
// identical to the pre-carve `emitCpp(ir, target, config)` API; `cppBackend` is the assembled
// backend the metadata test inspects.
import { emitCpp as baseEmitCpp, createCppBackend, EmitterRegistry } from "@keyma/compiler/backend-cpp";
import type { KeymaTargetConfig, ResolvedConfig, EmitResult, KeymaBackend } from "@keyma/compiler";
import type { KeymaIR } from "@keyma/core/ir";
import { schemaCppEmitterPack } from "../src/index.js";

const registry = new EmitterRegistry();
registry.register(schemaCppEmitterPack);

export const cppBackend: KeymaBackend = createCppBackend([schemaCppEmitterPack]);

export function emitCpp(ir: KeymaIR, target: KeymaTargetConfig, config: ResolvedConfig): Promise<EmitResult> {
    return baseEmitCpp(ir, target, config, registry);
}

// Test harness: the JS backend's `emitJs` now takes an `EmitterRegistry` of domain packs.
// This wrapper pre-registers the schema pack (exactly as the CLI does) so the backend test
// call sites stay identical to the pre-carve `emitJs(ir, target, config)` API.
import { emitJs as baseEmitJs, EmitterRegistry } from "@keyma/compiler/backend-js";
import type { KeymaTargetConfig, ResolvedConfig, EmitResult } from "@keyma/compiler";
import type { KeymaIR } from "@keyma/core/ir";
import { schemaJsEmitterPack } from "../src/index.js";

const registry = new EmitterRegistry();
registry.register(schemaJsEmitterPack);

export function emitJs(ir: KeymaIR, target: KeymaTargetConfig, config: ResolvedConfig): Promise<EmitResult> {
    return baseEmitJs(ir, target, config, registry);
}

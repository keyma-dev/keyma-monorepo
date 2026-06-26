// Test harness: the Python backend's `emitPython` now takes an `EmitterRegistry` of domain
// packs. This wrapper pre-registers the schema pack (as the CLI does) so the test call sites
// stay identical to the pre-carve `emitPython(ir, target, config)` API.
import { emitPython as baseEmitPython, EmitterRegistry } from "@keyma/compiler/backend-python";
import type { KeymaTargetConfig, ResolvedConfig, EmitResult } from "@keyma/compiler";
import type { KeymaIR } from "@keyma/core/ir";
import { schemaPythonEmitterPack } from "../src/index.js";

const registry = new EmitterRegistry();
registry.register(schemaPythonEmitterPack);

export function emitPython(ir: KeymaIR, target: KeymaTargetConfig, config: ResolvedConfig): Promise<EmitResult> {
    return baseEmitPython(ir, target, config, registry);
}

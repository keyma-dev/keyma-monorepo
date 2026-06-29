// Test harness: the Python backend's `emitPython` now takes neutral `PythonBackendOptions`. This
// wrapper pre-binds the schema domain's `classMetadata` builder (as the CLI does) so the test call
// sites stay identical to the pre-carve `emitPython(ir, target, config)` API.
import { emitPython as baseEmitPython } from "@keyma/compiler/backend-python";
import { defaultRuntimeSymbols, defaultRecordLayouts } from "@keyma/compiler";
import type { KeymaTargetConfig, ResolvedConfig, EmitResult } from "@keyma/compiler";
import { defaultIntrinsics } from "@keyma/core/ir";
import type { KeymaIR } from "@keyma/core/ir";
import { buildClassMetadata } from "../../src/metadata-descriptor.js";
import { errorCollectIntrinsic, schemaRuntimeSymbols, schemaRecordLayouts } from "../../src/runtime-contract.js";
import { withSchemaSynthesis } from "../synthesis-harness.js";

// Register the schema runtime contract (as `prepareDomains` does for the CLI) so the synthesized
// methods' `error.collect`/`record` nodes emit their Python forms.
defaultIntrinsics.register(errorCollectIntrinsic);
defaultRuntimeSymbols.registerAll(schemaRuntimeSymbols);
defaultRecordLayouts.registerAll(schemaRecordLayouts);

const pyOpts = { classMetadata: buildClassMetadata };

export function emitPython(ir: KeymaIR, target: KeymaTargetConfig, config: ResolvedConfig): Promise<EmitResult> {
    return baseEmitPython(withSchemaSynthesis(ir), target, config, pyOpts);
}

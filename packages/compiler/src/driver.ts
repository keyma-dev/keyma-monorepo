import { validateIR } from "@keyma/ir";
import type { IRDiagnostic } from "@keyma/ir";
import { mkError } from "@keyma/compiler-util";
import type { ResolvedConfig, KeymaFrontend, KeymaBackend, EmitFile, DriveResult } from "./types.js";

const IR_VALIDATION_CODE = "KEYMA000";
const NO_BACKEND_CODE = "KEYMA000";

/**
 * Run the full compiler pipeline:
 *   1. Frontend compiles sources to IR.
 *   2. IR is validated for structural correctness.
 *   3. If no errors, each target's backend emits files.
 *
 * The driver does not write files to disk — callers receive the list of EmitFiles
 * and may write them however they choose (CLI, in-memory for tests, etc.).
 */
export async function drive(
    config: ResolvedConfig,
    frontend: KeymaFrontend,
    backends: KeymaBackend[]
): Promise<DriveResult> {
    // Step 1: run the frontend
    const { ir, diagnostics: frontendDiags, tagManifest } = await frontend.compile(config);
    const allDiagnostics: IRDiagnostic[] = [...frontendDiags];
    const manifestOut = tagManifest !== undefined ? { tagManifest } : {};

    // Step 2: validate IR structure
    const validation = validateIR(ir);
    if (!validation.valid) {
        for (const err of validation.errors) {
            allDiagnostics.push(mkError(IR_VALIDATION_CODE, `IR validation: ${err}`));
        }
    }

    // Step 3: halt if there are errors
    if (allDiagnostics.some((d) => d.severity === "error")) {
        return { ir, emitted: [], diagnostics: allDiagnostics, hasErrors: true, ...manifestOut };
    }

    // Step 4: run backends for each configured target
    const emitted: EmitFile[] = [];
    for (const target of config.targets) {
        const backend = backends.find((b) => b.target === target.language);
        if (backend === undefined) {
            allDiagnostics.push(
                mkError(NO_BACKEND_CODE, `No backend registered for target language "${target.language}"`)
            );
            continue;
        }
        const result = await backend.emit(ir, target, config);
        emitted.push(...result.files);
        allDiagnostics.push(...result.diagnostics);
    }

    const hasErrors = allDiagnostics.some((d) => d.severity === "error");
    return { ir, emitted, diagnostics: allDiagnostics, hasErrors, ...manifestOut };
}

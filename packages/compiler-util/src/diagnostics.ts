import type { IRDiagnostic, IRSourceLocation } from "@keyma/ir";

/** Build an error-severity {@link IRDiagnostic}, with an optional source location. */
export function mkError(code: string, message: string, source?: IRSourceLocation): IRDiagnostic {
    return source !== undefined
        ? { code, severity: "error", message, source }
        : { code, severity: "error", message };
}

/** Build a warning-severity {@link IRDiagnostic}, with an optional source location. */
export function mkWarning(code: string, message: string, source?: IRSourceLocation): IRDiagnostic {
    return source !== undefined
        ? { code, severity: "warning", message, source }
        : { code, severity: "warning", message };
}

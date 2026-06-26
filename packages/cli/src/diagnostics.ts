import type { IRDiagnostic } from "@keyma/core/ir";

/** Format a diagnostic for terminal output. */
export function formatDiagnostic(d: IRDiagnostic): string {
    const sev = d.severity.toUpperCase();
    const loc = d.source !== undefined
        ? ` (${d.source.file}:${d.source.line}:${d.source.column})`
        : "";
    return `[${sev}] ${d.code}${loc}: ${d.message}`;
}

/** Print diagnostics to stderr. Returns the number of errors. */
export function printDiagnostics(diagnostics: readonly IRDiagnostic[]): number {
    let errors = 0;
    for (const d of diagnostics) {
        if (d.severity === "error") errors++;
        process.stderr.write(formatDiagnostic(d) + "\n");
    }
    return errors;
}

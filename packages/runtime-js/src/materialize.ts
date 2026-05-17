export type MaterializerFn = (value: Record<string, unknown>) => Record<string, unknown>;

export function applyMaterializers(
    materializers: ReadonlyArray<MaterializerFn>,
    value: Record<string, unknown>
): void {
    for (const mat of materializers) {
        mat(value);
    }
}

export type Summary = {
    n: number;
    mean_ms: number;
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    min_ms: number;
    max_ms: number;
};

export function summarize(samples_ms: number[]): Summary {
    if (samples_ms.length === 0) {
        return { n: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0, min_ms: 0, max_ms: 0 };
    }
    const sorted = [...samples_ms].sort((a, b) => a - b);
    const n = sorted.length;
    let sum = 0;
    for (const v of sorted) sum += v;
    return {
        n,
        mean_ms: sum / n,
        p50_ms: percentile(sorted, 0.5),
        p95_ms: percentile(sorted, 0.95),
        p99_ms: percentile(sorted, 0.99),
        min_ms: sorted[0]!,
        max_ms: sorted[n - 1]!,
    };
}

function percentile(sorted_ms: number[], q: number): number {
    if (sorted_ms.length === 0) return 0;
    const idx = Math.min(sorted_ms.length - 1, Math.floor(q * sorted_ms.length));
    return sorted_ms[idx]!;
}

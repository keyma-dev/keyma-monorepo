import type { BenchResult, ScenarioResult } from "./run.js";

export type ComparisonRow = {
    name: string;
    a_mean_ms: number | null;
    b_mean_ms: number | null;
    delta_ms: number | null;
    ratio: number | null;
};

export function compareResults(a: BenchResult, b: BenchResult): ComparisonRow[] {
    const byName = (rs: ScenarioResult[]): Map<string, ScenarioResult> => {
        const m = new Map<string, ScenarioResult>();
        for (const r of rs) m.set(r.name, r);
        return m;
    };
    const ma = byName(a.scenarios);
    const mb = byName(b.scenarios);
    const names = new Set<string>([...ma.keys(), ...mb.keys()]);
    const rows: ComparisonRow[] = [];
    for (const name of names) {
        const ra = ma.get(name);
        const rb = mb.get(name);
        const am = ra !== undefined && ra.skipped === undefined ? ra.mean_ms : null;
        const bm = rb !== undefined && rb.skipped === undefined ? rb.mean_ms : null;
        const delta = am !== null && bm !== null ? bm - am : null;
        const ratio = am !== null && bm !== null && am > 0 ? bm / am : null;
        rows.push({ name, a_mean_ms: am, b_mean_ms: bm, delta_ms: delta, ratio });
    }
    rows.sort((x, y) => x.name.localeCompare(y.name));
    return rows;
}

export function printComparison(a: BenchResult, b: BenchResult): void {
    const rows = compareResults(a, b);
    const headers = ["scenario", a.adapter + " ms", b.adapter + " ms", "delta ms", "ratio b/a"];
    const grid: string[][] = [headers];
    for (const r of rows) {
        grid.push([
            r.name,
            r.a_mean_ms !== null ? fmt(r.a_mean_ms) : "—",
            r.b_mean_ms !== null ? fmt(r.b_mean_ms) : "—",
            r.delta_ms !== null ? (r.delta_ms >= 0 ? "+" : "") + fmt(r.delta_ms) : "—",
            r.ratio !== null ? r.ratio.toFixed(2) + "x" : "—",
        ]);
    }
    const widths: number[] = [];
    for (const row of grid) row.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, c.length); });
    for (let i = 0; i < grid.length; i++) {
        const row = grid[i]!;
        const padded = row.map((cell, j) => {
            const w = widths[j] ?? 0;
            return j === 0 ? cell.padEnd(w) : cell.padStart(w);
        });
        console.log(padded.join("  "));
        if (i === 0) console.log(widths.map((w) => "-".repeat(w)).join("  "));
    }
}

function fmt(ms: number): string {
    if (ms >= 1000) return ms.toFixed(0);
    if (ms >= 10) return ms.toFixed(2);
    return ms.toFixed(3);
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BenchResult, ScenarioResult } from "./run.js";

export function printTable(result: BenchResult): void {
    const headers = ["scenario", "n", "mean ms", "p50 ms", "p95 ms", "p99 ms", "min ms", "max ms"];
    const rows: string[][] = result.scenarios.map((s) => [
        s.name,
        s.skipped !== undefined ? "—" : String(s.n),
        s.skipped !== undefined ? "skipped: " + s.skipped.reason : fmt(s.mean_ms),
        s.skipped !== undefined ? "" : fmt(s.p50_ms),
        s.skipped !== undefined ? "" : fmt(s.p95_ms),
        s.skipped !== undefined ? "" : fmt(s.p99_ms),
        s.skipped !== undefined ? "" : fmt(s.min_ms),
        s.skipped !== undefined ? "" : fmt(s.max_ms),
    ]);
    console.log(
        "\n" + result.adapter
            + " (" + result.node + ", " + result.platform + ", N=" + result.datasetSize + ")",
    );
    printGrid([headers, ...rows]);
}

function fmt(ms: number): string {
    if (ms >= 1000) return ms.toFixed(0);
    if (ms >= 10) return ms.toFixed(2);
    return ms.toFixed(3);
}

function printGrid(rows: string[][]): void {
    if (rows.length === 0) return;
    const widths: number[] = [];
    for (const row of rows) {
        row.forEach((cell, i) => {
            widths[i] = Math.max(widths[i] ?? 0, cell.length);
        });
    }
    for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!;
        const padded = row.map((cell, i) => {
            const w = widths[i] ?? 0;
            // Left-align the first column (scenario name), right-align numbers.
            return i === 0 ? cell.padEnd(w) : cell.padStart(w);
        });
        console.log(padded.join("  "));
        if (r === 0) {
            console.log(widths.map((w) => "-".repeat(w)).join("  "));
        }
    }
}

export async function writeResult(result: BenchResult, dir: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const fname = result.timestamp.replace(/[:.]/g, "-") + ".json";
    const fpath = path.join(dir, fname);
    await fs.writeFile(fpath, JSON.stringify(result, null, 2) + "\n", "utf8");
    return fpath;
}

export async function readResult(fpath: string): Promise<BenchResult> {
    const raw = await fs.readFile(fpath, "utf8");
    return JSON.parse(raw) as BenchResult;
}

export type { ScenarioResult };

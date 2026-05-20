import type { KeymaDatabaseAdapter } from "@keyma/runtime-js";
import {
    DEFAULT_ITERATIONS,
    DEFAULT_WARMUP,
    SCENARIOS,
    type BenchContext,
    type Scenario,
} from "./scenarios.js";
import { summarize, type Summary } from "./stats.js";

export type ScenarioResult = Summary & {
    name: string;
    description: string;
    warmup: number;
    skipped?: { reason: string };
};

export type BenchResult = {
    adapter: string;
    adapterVersion?: string;
    timestamp: string;
    node: string;
    platform: string;
    datasetSize: number;
    scenarios: ScenarioResult[];
};

export type RunOptions = {
    adapterName: string;
    adapterVersion?: string;
    datasetSize?: number;
    /** Called before each scenario's `setup` to clear adapter state.
     *  Required: scenarios assume an empty database. */
    reset(): Promise<void>;
    /** Optional progress callback so the bootstrap can print a one-line update
     *  per scenario without waiting for the whole run to finish. */
    onScenarioStart?(scenario: Scenario): void;
    onScenarioEnd?(result: ScenarioResult): void;
    /** Restrict to a subset of scenarios by name. Default: all. */
    only?: readonly string[];
};

export async function runBenchmark(
    adapter: KeymaDatabaseAdapter,
    opts: RunOptions,
): Promise<BenchResult> {
    const datasetSize = opts.datasetSize ?? 10_000;
    const scenarios = opts.only !== undefined
        ? SCENARIOS.filter((s) => opts.only!.includes(s.name))
        : SCENARIOS;

    const results: ScenarioResult[] = [];
    for (const scenario of scenarios) {
        opts.onScenarioStart?.(scenario);
        const result = await runScenario(adapter, scenario, datasetSize, opts.reset);
        results.push(result);
        opts.onScenarioEnd?.(result);
    }

    return {
        adapter: opts.adapterName,
        ...(opts.adapterVersion !== undefined ? { adapterVersion: opts.adapterVersion } : {}),
        timestamp: new Date().toISOString(),
        node: process.version,
        platform: process.platform + "-" + process.arch,
        datasetSize,
        scenarios: results,
    };
}

async function runScenario(
    adapter: KeymaDatabaseAdapter,
    scenario: Scenario,
    datasetSize: number,
    reset: () => Promise<void>,
): Promise<ScenarioResult> {
    const iterations = scenario.iterations ?? DEFAULT_ITERATIONS;
    const warmup = scenario.warmup ?? DEFAULT_WARMUP;

    await reset();

    const ctx: BenchContext = { adapter, datasetSize, state: {} };
    try {
        if (scenario.setup !== undefined) await scenario.setup(ctx);
    } catch (e) {
        return {
            name: scenario.name,
            description: scenario.description,
            warmup,
            n: 0,
            mean_ms: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0, min_ms: 0, max_ms: 0,
            skipped: { reason: errorMessage(e) },
        };
    }

    // Warmup
    for (let i = 0; i < warmup; i++) {
        await scenario.iteration(ctx, i);
    }

    // Timed loop. We index continuing from `warmup` so iteration-by-i semantics
    // (e.g. `delete.user.byId` consuming a pool) stay consistent across warmup
    // and timed phases.
    const samples_ms: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const start = process.hrtime.bigint();
        await scenario.iteration(ctx, warmup + i);
        const end = process.hrtime.bigint();
        samples_ms.push(Number(end - start) / 1e6);
    }

    if (scenario.teardown !== undefined) {
        try {
            await scenario.teardown(ctx);
        } catch {
            // Teardown failures don't invalidate the measurement.
        }
    }

    const summary = summarize(samples_ms);
    return {
        name: scenario.name,
        description: scenario.description,
        warmup,
        ...summary,
    };
}

function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    return String(e);
}

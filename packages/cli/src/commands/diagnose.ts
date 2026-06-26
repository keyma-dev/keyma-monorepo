import { resolve } from "node:path";
import type { KeymaDomain } from "@keyma/compiler";
import { KNOWN_DOMAIN_PACKAGES, probeDomain } from "../domains.js";
import { loadResolvedConfig } from "./build.js";

export type DiagnoseOptions = {
    /** Project root. Defaults to cwd. */
    cwd?: string;
    /** Path to a config file. If omitted, the loader searches `cwd`. */
    configPath?: string;
};

/** What a single loaded domain contributes, for the diagnose listing. */
export type DiagnoseDomainInfo = {
    /** Package specifier it was loaded from. */
    spec: string;
    /** The domain's own id (`keymaDomain.name`). */
    name: string;
    /** The frontend extraction domain's name. */
    frontend: string;
    /** Whether it registers an IR section validator. */
    irValidator: boolean;
    /** Which backend languages it contributes emitter packs for. */
    languages: string[];
    /** Whether it will actually be loaded given the current selection. */
    active: boolean;
};

/** A domain package that is installed but failed to load (broken `keymaDomain`). */
export type DiagnoseProblem = { spec: string; message: string };

export type DiagnoseReport = {
    /** Resolved config path, or undefined when no config was found. */
    configPath?: string;
    /** How the domain set is chosen. */
    selection: "auto-detect" | "configured";
    /** The explicit `config.domains` list, when configured. */
    requested?: string[];
    /** Configured target languages (empty when no config / no targets). */
    targets: string[];
    /** Domains discovered (installed) — active ones are loaded for builds. */
    domains: DiagnoseDomainInfo[];
    /** Installed domain packages whose `keymaDomain` is broken. */
    problems: DiagnoseProblem[];
    /** Configured domains that are not installed (a build would fail). */
    missing: string[];
};

function languagesOf(domain: KeymaDomain): string[] {
    const langs: string[] = [];
    if (domain.emitterPacks.js !== undefined) langs.push("js");
    if (domain.emitterPacks.python !== undefined) langs.push("python");
    if (domain.emitterPacks.cpp !== undefined) langs.push("cpp");
    return langs;
}

/**
 * Inspect the project's domain wiring without running a build: which domains are
 * installed, which will be loaded, what each contributes, and any problems. Tolerates a
 * missing/invalid config (falls back to auto-detection reporting).
 */
export async function runDiagnose(opts: DiagnoseOptions = {}): Promise<DiagnoseReport> {
    const cwd = resolve(opts.cwd ?? process.cwd());

    let configPath: string | undefined;
    let requested: string[] | undefined;
    let targets: string[] = [];
    try {
        const loaded = await loadResolvedConfig(cwd, opts.configPath);
        configPath = loaded.configPath;
        requested = loaded.config.domains;
        targets = loaded.config.targets.map((t) => t.language);
    } catch {
        // No (or unreadable) config — report auto-detection of the known domains.
    }

    const selection: "auto-detect" | "configured" = requested === undefined ? "auto-detect" : "configured";
    // Probe the union of configured specifiers and the known built-ins, preserving order
    // (configured first) and de-duplicating.
    const specs = [...new Set([...(requested ?? []), ...KNOWN_DOMAIN_PACKAGES])];

    const domains: DiagnoseDomainInfo[] = [];
    const problems: DiagnoseProblem[] = [];
    const missing: string[] = [];

    for (const spec of specs) {
        const probe = await probeDomain(spec);
        // A domain is "active" (loaded for builds) when configured explicitly, or when
        // auto-detecting and it is one of the known built-ins.
        const isActiveSelection =
            requested !== undefined ? requested.includes(spec) : (KNOWN_DOMAIN_PACKAGES as readonly string[]).includes(spec);
        switch (probe.status) {
            case "loaded":
                domains.push({
                    spec,
                    name: probe.domain.name,
                    frontend: probe.domain.frontend.name,
                    irValidator: probe.domain.irValidator !== undefined,
                    languages: languagesOf(probe.domain),
                    active: isActiveSelection,
                });
                break;
            case "invalid":
                problems.push({ spec, message: probe.message });
                break;
            case "not-installed":
                // Only a problem when explicitly configured; a known-but-absent built-in is fine.
                if (requested !== undefined && requested.includes(spec)) missing.push(spec);
                break;
        }
    }

    return {
        selection,
        targets,
        domains,
        problems,
        missing,
        ...(configPath !== undefined ? { configPath } : {}),
        ...(requested !== undefined ? { requested } : {}),
    };
}

/** Render a {@link DiagnoseReport} as human-readable lines. */
export function formatDiagnoseReport(report: DiagnoseReport): string {
    const lines: string[] = [];
    lines.push("Keyma project diagnosis");
    lines.push(`  config:     ${report.configPath ?? "(none found)"}`);
    lines.push(`  domains:    ${report.selection}${report.requested !== undefined ? ` [${report.requested.join(", ") || "core only"}]` : ""}`);
    lines.push(`  targets:    ${report.targets.length > 0 ? report.targets.join(", ") : "(none)"}`);

    lines.push("");
    if (report.domains.length === 0) {
        lines.push("  No domains loaded (core-only output).");
    } else {
        lines.push("  Domains:");
        for (const d of report.domains) {
            const status = d.active ? "active" : "installed, not loaded";
            const seams = [
                `frontend: ${d.frontend}`,
                `ir: ${d.irValidator ? "yes" : "no"}`,
                `backends: ${d.languages.length > 0 ? d.languages.join("/") : "none"}`,
            ].join("  ·  ");
            lines.push(`    ${d.name}  (${d.spec})  — ${status}`);
            lines.push(`        ${seams}`);
        }
    }

    if (report.missing.length > 0) {
        lines.push("");
        lines.push("  Missing (configured but not installed):");
        for (const spec of report.missing) lines.push(`    ${spec}`);
    }
    if (report.problems.length > 0) {
        lines.push("");
        lines.push("  Problems:");
        for (const p of report.problems) lines.push(`    ${p.spec}: ${p.message}`);
    }
    return lines.join("\n") + "\n";
}

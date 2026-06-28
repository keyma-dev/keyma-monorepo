import { defaultIRValidators, defaultIntrinsics } from "@keyma/core/ir";
import type { IRDocumentValidator } from "@keyma/core/ir";
import { defaultRuntimeSymbols, defaultRecordLayouts } from "@keyma/compiler";
import type { KeymaBackend, KeymaDomain } from "@keyma/compiler";
import type { FrontendDomain } from "@keyma/compiler/frontend-ts";
import { createJsBackend } from "@keyma/compiler/backend-js";
import { createPythonBackend } from "@keyma/compiler/backend-python";
import { createCppBackend } from "@keyma/compiler/backend-cpp";

/**
 * Built-in domain packages probed during auto-detection (when the project sets no explicit
 * `domains`). A package is loaded only if it is installed *and* exports a valid `keymaDomain`.
 * Third-party domains are loaded by naming them explicitly in `config.domains`. Adding a new
 * official domain here is the only CLI edit a future domain needs — everything else flows
 * through the `keymaDomain` descriptor.
 */
export const KNOWN_DOMAIN_PACKAGES = ["@keyma/schema", "@keyma/ui"] as const;

/** Outcome of resolving which domains to load for a build. */
export type DomainResolution = {
    /** Loaded domain descriptors, in load order. */
    domains: KeymaDomain[];
    /** Specifiers that were successfully loaded. */
    loaded: string[];
    /** Known built-in domain packages found installed (resolvable) — for diagnostics. */
    available: string[];
    /** True when the list was auto-detected (no explicit `config.domains`). */
    autoDetected: boolean;
};

/** The wired-up pieces a build needs from the resolved domains. */
export type DomainSetup = {
    /** Frontend extraction domains, passed to `compile({ domains })`. */
    frontendDomains: FrontendDomain[];
    /** The per-language backends, assembled from each domain's emitter packs. */
    backends: KeymaBackend[];
    /** Specifiers that were loaded (for logging/diagnostics). */
    loaded: string[];
    /** The loaded domain descriptors — retained so a cache hit can re-validate `targets`
     *  against a (possibly different) configured target set. */
    domains: KeymaDomain[];
};

/**
 * Fail fast when a loaded domain that declares `targets` does not cover a configured build target.
 * A domain that cannot emit for a requested language is a misconfiguration, not a silent partial
 * emit. A domain with no `targets` imposes no constraint. No-op when no targets are supplied.
 */
function validateDomainTargets(domains: readonly KeymaDomain[], configuredTargets?: readonly string[]): void {
    if (configuredTargets === undefined) return;
    for (const domain of domains) {
        if (domain.targets === undefined) continue;
        const missing = configuredTargets.filter((t) => !domain.targets!.includes(t));
        if (missing.length > 0) {
            throw new Error(
                `Domain "${domain.name}" does not support configured target(s) ${missing.map((t) => `"${t}"`).join(", ")}. ` +
                `It declares support for: ${domain.targets.map((t) => `"${t}"`).join(", ") || "(none)"}.`
            );
        }
    }
}

function isNotFound(err: unknown): boolean {
    const code = (err as { code?: unknown } | null | undefined)?.code;
    return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/** Runtime shape check for the `keymaDomain` export of a dynamically-loaded package. A frontend
 *  domain is a declarative descriptor: it carries its DSL module + the decorators it owns (the
 *  compiler owns the driver and dispatches them), not a `produce()` method. */
function isKeymaDomain(value: unknown): value is KeymaDomain {
    if (typeof value !== "object" || value === null) return false;
    const d = value as Record<string, unknown>;
    const frontend = d["frontend"] as Record<string, unknown> | null;
    return (
        typeof d["name"] === "string" &&
        typeof frontend === "object" &&
        frontend !== null &&
        typeof frontend["dslModule"] === "string" &&
        Array.isArray(frontend["decorators"]) &&
        typeof d["emitterPacks"] === "object" &&
        d["emitterPacks"] !== null
    );
}

/** The result of probing a single domain package — never throws, for diagnostics. */
export type DomainProbe =
    | { spec: string; status: "loaded"; domain: KeymaDomain }
    | { spec: string; status: "not-installed" }
    | { spec: string; status: "invalid"; message: string };

/**
 * Dynamically import a domain package and classify the outcome without throwing. Resolution
 * uses standard Node ESM resolution from the CLI's module graph (in a workspace/hoisted
 * install the domain packages sit alongside `@keyma/cli`).
 */
export async function probeDomain(spec: string): Promise<DomainProbe> {
    let mod: Record<string, unknown>;
    try {
        mod = (await import(spec)) as Record<string, unknown>;
    } catch (err) {
        if (isNotFound(err)) return { spec, status: "not-installed" };
        const message = err instanceof Error ? err.message : String(err);
        return { spec, status: "invalid", message };
    }
    const domain = mod["keymaDomain"];
    if (!isKeymaDomain(domain)) {
        return {
            spec,
            status: "invalid",
            message:
                `does not export a valid \`keymaDomain\` ` +
                `(expected { name, frontend, emitterPacks })`,
        };
    }
    return { spec, status: "loaded", domain };
}

/**
 * Load a domain package's `keymaDomain` descriptor. Returns `undefined` when the package is
 * not installed; throws a clear error when it is installed but does not export a usable domain.
 */
async function loadDomain(spec: string): Promise<KeymaDomain | undefined> {
    const probe = await probeDomain(spec);
    switch (probe.status) {
        case "loaded":
            return probe.domain;
        case "not-installed":
            return undefined;
        case "invalid":
            throw new Error(
                `Package "${spec}" ${probe.message}. Is it a Keyma domain package?`
            );
    }
}

/**
 * Decide which domains to load and load them.
 *
 *  - `requested` undefined → **auto-detect**: probe {@link KNOWN_DOMAIN_PACKAGES} and load
 *    every one that is installed and exports a `keymaDomain`.
 *  - `requested` an explicit list (possibly empty) → load exactly those; a named-but-missing
 *    package is a hard error, and any installed-but-unlisted built-in domain is warned about.
 */
export async function resolveDomains(requested?: readonly string[]): Promise<DomainResolution> {
    if (requested === undefined) {
        const domains: KeymaDomain[] = [];
        const loaded: string[] = [];
        for (const spec of KNOWN_DOMAIN_PACKAGES) {
            const domain = await loadDomain(spec);
            if (domain !== undefined) {
                domains.push(domain);
                loaded.push(spec);
            }
        }
        return { domains, loaded, available: [...loaded], autoDetected: true };
    }

    // Explicit list: every entry is required.
    const domains: KeymaDomain[] = [];
    const loaded: string[] = [];
    for (const spec of requested) {
        const domain = await loadDomain(spec);
        if (domain === undefined) {
            throw new Error(
                `Configured domain "${spec}" is not installed. ` +
                `Install it (e.g. \`npm install ${spec}\`) or remove it from \`domains\`.`
            );
        }
        domains.push(domain);
        loaded.push(spec);
    }
    const available = await detectAvailable();
    for (const spec of available) {
        if (!requested.includes(spec)) {
            process.stderr.write(
                `warning: domain "${spec}" is installed but not listed in \`domains\` — it will not be loaded.\n`
            );
        }
    }
    return { domains, loaded, available, autoDetected: false };
}

/** The subset of {@link KNOWN_DOMAIN_PACKAGES} that is installed (resolvable). */
export async function detectAvailable(): Promise<string[]> {
    const found: string[] = [];
    for (const spec of KNOWN_DOMAIN_PACKAGES) {
        try {
            const domain = await loadDomain(spec);
            if (domain !== undefined) found.push(spec);
        } catch {
            // A broken domain package shouldn't fail mere availability detection.
        }
    }
    return found;
}

// Registered IR section validators, tracked so repeated builds (watch mode) register each
// domain's validator exactly once onto the shared `defaultIRValidators` registry.
const registeredValidators = new Set<IRDocumentValidator>();
// Assembled setups, cached by the resolution key so watch-mode rebuilds reuse them (and the
// "loaded domains" line is logged only once per key).
const setupCache = new Map<string, DomainSetup>();

function setupKey(requested?: readonly string[]): string {
    return requested === undefined ? " auto" : JSON.stringify([...requested]);
}

/**
 * Resolve the configured/auto-detected domains and wire them across the seams a build needs:
 * register each domain's IR validator + intrinsics (idempotently), collect the frontend domains,
 * and assemble the per-language backends from the domain emitter packs. When `configuredTargets`
 * is given, a domain that declares `targets` must cover every configured target or the build
 * fails fast with a config error. Cached per resolution key.
 */
export async function prepareDomains(
    requested?: readonly string[],
    configuredTargets?: readonly string[],
): Promise<DomainSetup> {
    const key = setupKey(requested);
    const cached = setupCache.get(key);
    if (cached !== undefined) {
        validateDomainTargets(cached.domains, configuredTargets);
        return cached;
    }

    const { domains, loaded, autoDetected } = await resolveDomains(requested);

    // Fail fast on a configured target a loaded domain cannot emit for (decision 11).
    validateDomainTargets(domains, configuredTargets);

    // Register IR section checks onto the core (envelope-only) validator registry that
    // `drive()`'s `validateIR` consults. Idempotent: a given validator is registered once.
    for (const domain of domains) {
        const validator = domain.irValidator;
        if (validator !== undefined && !registeredValidators.has(validator)) {
            defaultIRValidators.register(validator);
            registeredValidators.add(validator);
        }
        // Merge the domain's contributed intrinsics into the shared registry the frontend
        // recognizer and the driver's pre-emit scan both consult. Registration is keyed by op
        // id, so re-running (watch mode) is idempotent.
        if (domain.intrinsics !== undefined) {
            defaultIntrinsics.registerAll(domain.intrinsics);
        }
        // Merge the domain's runtime-provided type symbols + C++ record layouts into the compiler's
        // shared registries the per-language type/record emitters consult. Keyed by canonical name,
        // so re-running (watch mode) is idempotent.
        if (domain.runtimeSymbols !== undefined) {
            defaultRuntimeSymbols.registerAll(domain.runtimeSymbols);
        }
        if (domain.recordLayouts !== undefined) {
            defaultRecordLayouts.registerAll(domain.recordLayouts);
        }
    }

    const frontendDomains = domains.map((d) => d.frontend);
    const jsPacks = domains.flatMap((d) => (d.emitterPacks.js !== undefined ? [d.emitterPacks.js] : []));
    const pyPacks = domains.flatMap((d) => (d.emitterPacks.python !== undefined ? [d.emitterPacks.python] : []));
    const cppPacks = domains.flatMap((d) => (d.emitterPacks.cpp !== undefined ? [d.emitterPacks.cpp] : []));
    const backends: KeymaBackend[] = [
        createJsBackend(jsPacks),
        createPythonBackend(pyPacks),
        createCppBackend(cppPacks),
    ];

    const label = autoDetected ? "auto-detected" : "configured";
    const list = loaded.length > 0 ? loaded.join(", ") : "(none — core only)";
    process.stderr.write(`keyma: ${label} domains: ${list}\n`);

    const setup: DomainSetup = { frontendDomains, backends, loaded, domains };
    setupCache.set(key, setup);
    return setup;
}

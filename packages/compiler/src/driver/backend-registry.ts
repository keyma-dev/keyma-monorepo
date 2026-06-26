import type { KeymaBackend } from "./types.js";

/**
 * A registry of language backends, keyed by their `target` language id.
 *
 * The driver itself stays a pure function over a `KeymaBackend[]` (it never imports a
 * backend package — backends import the driver, so the reverse edge would be a cycle).
 * This registry is the seam where a host (the CLI) assembles that array: it pre-registers
 * the built-in js/python/cpp backends and, in a later reorg phase, any domain-contributed
 * backends, then hands `list()` to `drive()`. Registering more backends never requires
 * editing the driver.
 */
export class BackendRegistry {
    private readonly backends = new Map<string, KeymaBackend>();

    /** Register a backend. A later registration for the same `target` overrides an earlier one. */
    register(backend: KeymaBackend): void {
        this.backends.set(backend.target, backend);
    }

    /** Register several backends, in iteration order. */
    registerAll(backends: Iterable<KeymaBackend>): void {
        for (const backend of backends) this.register(backend);
    }

    /** The backend handling a target language, or undefined when none is registered. */
    get(target: string): KeymaBackend | undefined {
        return this.backends.get(target);
    }

    /** All registered backends, in registration order — the array to pass to `drive()`. */
    list(): KeymaBackend[] {
        return [...this.backends.values()];
    }
}

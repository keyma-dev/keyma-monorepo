import type { IRClassDeclaration, IRDiagnostic } from "@keyma/core/ir";
import { inheritedFields } from "@keyma/core/util";
import { mkError, KEYMA001, KEYMA031, KEYMA037 } from "./diagnostics.js";

// Base-language validation over the domain-neutral core IR (class names, visibility, and the
// reference/embedded type kinds). These read no domain extension slice, so the compiler owns
// them and runs them over every lowered class; a domain layers its own checks on top.

/** KEYMA001: two classes must not share the same canonical `name`. */
export function checkDuplicateNames(classes: IRClassDeclaration[], diagnostics: IRDiagnostic[]): void {
    const seen = new Map<string, string>(); // name → sourceName
    for (const cls of classes) {
        const existing = seen.get(cls.name);
        if (existing !== undefined) {
            diagnostics.push(
                mkError(KEYMA001, `Duplicate class name "${cls.name}" (used by both "${existing}" and "${cls.sourceName}")`, cls.source)
            );
        } else {
            seen.set(cls.name, cls.sourceName);
        }
    }
}

/** KEYMA031: a public class must not publicly expose a private class via a reference/embedded field. */
export function checkVisibilityLeaks(classes: IRClassDeclaration[], diagnostics: IRDiagnostic[]): void {
    const privateClasses = new Set(classes.filter((s) => s.visibility === "private").map((s) => s.sourceName));

    for (const cls of classes) {
        if (cls.visibility !== "public") continue;
        for (const field of cls.fields) {
            if (field.visibility === "private") continue;
            const t = field.type;
            if ((t.kind === "reference" || t.kind === "embedded") && privateClasses.has(t.target)) {
                diagnostics.push(
                    mkError(
                        KEYMA031,
                        `Public class "${cls.sourceName}" exposes private class "${t.target}" via field "${field.name}"`,
                        field.source
                    )
                );
            }
        }
    }
}

// KEYMA037: a public class whose fields are *all* private has no public surface.
// It would emit into the client bundle with nothing readable, while on the server
// its default (unprojected) read produces an empty projection — which adapters
// treat as "return the whole record", leaking the private data the author meant
// to hide. The fix is mechanical: mark the class private (so only the system
// identity can reach it) or make at least one field public. A field counts as
// public surface whatever its kind — stored, reference, or embedded. Getters are
// behaviors (re-emitted accessors), not stored/projected data, so they do not
// count. Fieldless classes are exempt (nothing to leak and nothing to expose).
export function checkPublicSurface(classes: IRClassDeclaration[], diagnostics: IRDiagnostic[]): void {
    const bySourceName = new Map(classes.map((s) => [s.sourceName, s]));
    for (const cls of classes) {
        if (cls.visibility !== "public") continue;
        // Inheritance is real: an instance's public surface includes inherited fields, so a
        // child with only own-private fields still passes if it inherits a public one.
        const all = inheritedFields(cls, bySourceName);
        if (all.length === 0) continue;
        if (all.some((f) => f.visibility === "public")) continue;
        diagnostics.push(
            mkError(
                KEYMA037,
                `Public class "${cls.sourceName}" has only private fields — a public class must expose at least one public field. Mark it private, or make a field public.`,
                cls.source,
            ),
        );
    }
}

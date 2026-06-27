import type { KeymaIR, IRDiagnostic, IRStatement } from "@keyma/core/ir";
import { BUILTIN_INTRINSIC_OPS, defaultIntrinsics } from "@keyma/core/ir";
import { collectIntrinsicOpsInStatement, collectIntrinsicOps, mkError } from "@keyma/core/util";
import { KEYMA0208 } from "../frontend-ts/diagnostics.js";
import type { RuntimeSymbolLang } from "./runtime-symbols.js";

/**
 * Driver pre-emit compatibility scan (decision 11).
 *
 * Before any backend runs, walk every reachable function body, collect the intrinsic ops it
 * uses, and confirm each op is emittable for every configured target. A **built-in** core
 * intrinsic is emittable everywhere (the backends translate it directly). A **domain-contributed**
 * op is emittable for a target only when its registry `emit[<target>]` snippet is present; a
 * configured target missing that snippet is a hard build error naming **(function, op, target)**,
 * so a domain that emits for JS + C++ but not Python fails fast rather than producing a broken
 * Python validator.
 *
 * Built-in-only documents (every op in {@link BUILTIN_INTRINSIC_OPS}) never produce a diagnostic,
 * so this is inert until a domain contributes its own intrinsics.
 */
export function scanIntrinsicCompatibility(ir: KeymaIR, targetLanguages: readonly string[]): IRDiagnostic[] {
    // Only the three known backend languages map to an emit key; an unknown target language has
    // no emitter table to reason about (the driver reports its missing backend separately), so it
    // is skipped here.
    const langs = targetLanguages.filter((l): l is RuntimeSymbolLang => l === "js" || l === "python" || l === "cpp");
    if (langs.length === 0) return [];

    const diagnostics: IRDiagnostic[] = [];

    /** Check every op a body uses against every configured target, naming the offending site. */
    const checkBody = (statements: readonly IRStatement[], site: string): void => {
        const ops = new Set<string>();
        for (const s of statements) collectIntrinsicOpsInStatement(s, ops);
        for (const op of ops) {
            for (const lang of langs) {
                if (!emittable(op, lang)) {
                    diagnostics.push(mkError(
                        KEYMA0208,
                        `Intrinsic op "${op}" used in ${site} has no emitter for target "${lang}" — ` +
                        `the domain that contributes it must provide an \`emit.${lang}\` snippet`,
                    ));
                }
            }
        }
    };

    for (const fn of ir.functionDeclarations ?? []) {
        checkBody(fn.statements, `function "${fn.name}"`);
    }

    for (const cls of ir.classes) {
        for (const method of cls.methods ?? []) {
            checkBody(method.statements, `${method.kind} "${cls.sourceName}.${method.name}"`);
            // The audience fallback body is emitted for non-matching bundles — scan it too.
            if (method.bodyAudience !== undefined) {
                checkBody(method.bodyAudience.fallback, `${method.kind} "${cls.sourceName}.${method.name}" (fallback)`);
            }
        }
        for (const field of cls.fields) {
            if (field.default !== undefined && field.default.kind === "expression") {
                const ops = new Set<string>();
                collectIntrinsicOps(field.default.expression, ops);
                for (const op of ops) {
                    for (const lang of langs) {
                        if (!emittable(op, lang)) {
                            diagnostics.push(mkError(
                                KEYMA0208,
                                `Intrinsic op "${op}" used in default of "${cls.sourceName}.${field.name}" has no ` +
                                `emitter for target "${lang}" — the domain that contributes it must provide an ` +
                                `\`emit.${lang}\` snippet`,
                            ));
                        }
                    }
                }
            }
        }
    }

    return diagnostics;
}

/**
 * Whether an intrinsic op can be emitted for a target language. Built-in core ops are translated
 * directly by each backend; a domain op is emittable only when it carries a registry `emit`
 * snippet for that language. An op unknown to the registry entirely is not emittable (though
 * `validateIR` rejects unknown ops upstream).
 */
function emittable(op: string, lang: RuntimeSymbolLang): boolean {
    if (BUILTIN_INTRINSIC_OPS.has(op)) return true;
    return defaultIntrinsics.byOpId(op)?.emit?.[lang] !== undefined;
}

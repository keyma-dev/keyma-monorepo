import type { IRMember } from "@keyma/core/ir";
import type { CppEmitterPack } from "@keyma/compiler/backend-cpp";
import { buildClassData } from "./schema-data.js";
import { factoryNames, renderClaimedFunctions } from "./emit-validators.js";
import { fieldValidators, fieldFormatters } from "../ir/extensions.js";

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

/**
 * The schema-domain C++ emitter pack: supplies the per-class `metadata()` data (as neutral
 * data the compiler renders) and — since the validator→function collapse — the validator/
 * formatter factory wrapper rendering. The CLI registers it into the generic C++ backend's
 * `EmitterRegistry`; `@keyma/compiler` references no schema symbol. (`@Service` emission — the
 * service / service-client headers — is compiler-owned: the bundle shell emits them directly.)
 * Named-enum emission is also compiler-owned. Validator/formatter factories are claimed here and
 * rendered (with the runtime guard wrapper) into their own source module by the generic module emitter.
 */
export const schemaCppEmitterPack: CppEmitterPack = {
    name: "schema",
    buildClassData,
    /**
     * The function names a class's members reference — validators always, formatters gated to
     * the client form phases when `bundle === "client"`. Read from this domain's own
     * `extensions['schema']` slice so `@keyma/compiler` does no schema-slice read of its own.
     */
    referencedFunctionNames(members: readonly IRMember[], { bundle }): ReadonlySet<string> {
        const out = new Set<string>();
        const formOnly = bundle === "client";
        for (const m of members) {
            for (const v of fieldValidators(m)) out.add(v.name);
            for (const fm of fieldFormatters(m)) {
                if (formOnly && !CLIENT_PHASES.has(fm.phase)) continue;
                out.add(fm.spec.name);
            }
        }
        return out;
    },
    claimFunctions: (ir) => {
        const { validatorNames, formatterNames } = factoryNames(ir);
        const claimed = new Set<string>(validatorNames);
        for (const n of formatterNames) claimed.add(n);
        return claimed;
    },
    renderClaimedFunctions,
};

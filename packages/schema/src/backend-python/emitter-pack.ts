import type { PythonEmitterPack } from "@keyma/compiler/backend-python";
import type { IRMember } from "@keyma/core/ir";
import { buildClassData } from "./schema-data.js";
import { factoryNames, renderClaimedFunctions } from "./emit-validators.js";
import { fieldValidators, fieldFormatters } from "../ir/extensions.js";

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

/**
 * The schema-domain Python emitter pack: supplies the per-class `<Class>.metadata` builder, the
 * `referencedFunctionNames` hook (the validator/formatter factory names a class's members reference),
 * and — since the validator→function collapse — the validator/formatter factory wrapper rendering.
 * The CLI registers it into the generic Python backend's `EmitterRegistry`; `@keyma/compiler`
 * references no schema symbol. Validator/formatter factories are claimed here and rendered (with
 * the runtime guard wrapper) co-located in their source module by the generic module emitter.
 * (Python omits services/enums by design.)
 */
export const schemaPythonEmitterPack: PythonEmitterPack = {
    name: "schema",
    buildClassData,
    /**
     * The union of validator + formatter factory names the given members reference. Formatters are
     * gated to the form phases for a `client` bundle (mirroring the metadata gating); validators are
     * always included. Read from the schema domain's own `extensions['schema']` slice.
     */
    referencedFunctionNames(members: readonly IRMember[], ctx: { bundle: "client" | "server" | "library" }): ReadonlySet<string> {
        const out = new Set<string>();
        for (const m of members) {
            for (const v of fieldValidators(m)) out.add(v.name);
            for (const fmt of fieldFormatters(m)) {
                if (ctx.bundle === "client" && !CLIENT_PHASES.has(fmt.phase)) continue;
                out.add(fmt.spec.name);
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

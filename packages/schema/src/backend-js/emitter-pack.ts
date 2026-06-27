import { path } from "@keyma/core/util";
import type { IRMember } from "@keyma/core/ir";
import type { EmitFile } from "@keyma/compiler";
import type { JsEmitterPack } from "@keyma/compiler/backend-js";
import { buildClassData } from "./schema-data.js";
import { shapeClassDts } from "./schema-dts.js";
import { factoryNames, renderClaimedFunctions } from "./emit-validators.js";
import { EMITTED_SCHEMA_TYPES_DTS } from "./emitted-runtime-types.js";
import { EMITTED_SCHEMA_RUNTIME_MODULES } from "./emitted-schema-runtime.js";
import { fieldValidators, fieldFormatters } from "../ir/extensions.js";

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

/**
 * The schema-domain JS emitter pack: supplies the per-class `<Class>.metadata` builder, the edge
 * `.d.ts` shaping, the `ClassMetadata` runtime type surface, the per-member referenced-function
 * set (validators + formatters), and — since the validator→function collapse — the
 * validator/formatter factory wrapper rendering. The CLI registers it into the generic JS
 * backend's `EmitterRegistry`; `@keyma/compiler` references no schema symbol. (`@Service`
 * emission is compiler-owned: the bundle shell emits the services file directly.)
 */
export const schemaJsEmitterPack: JsEmitterPack = {
    name: "schema",
    buildClassData,
    shapeClassDts,
    runtimeTypeDecls: () => EMITTED_SCHEMA_TYPES_DTS,
    /**
     * The validator + formatter factory names a class's members reference. The generic backend
     * seeds tree-shaking and wires factory imports from this set; the schema domain reads its own
     * `extensions['schema']` member slice. Formatters are gated to the form phases on the client
     * bundle (matching the client metadata that keeps only those phases).
     */
    referencedFunctionNames: (members: readonly IRMember[], ctx) => {
        const out = new Set<string>();
        for (const member of members) {
            for (const v of fieldValidators(member)) out.add(v.name);
            for (const f of fieldFormatters(member)) {
                if (ctx.bundle === "client" && !CLIENT_PHASES.has(f.phase)) continue;
                out.add(f.spec.name);
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
    /**
     * The opt-in validation API: the `validate` / `format` / `applyDefaults` drivers (+ their
     * shared `schema-fields` field walker), baked verbatim from `@keyma/runtime` as bundle-local
     * modules. An app imports them from the bundle (`./validate.js`, …) and calls them against a
     * generated class's `.metadata` — no `@keyma/runtime` dependency. The drivers are generic over
     * the metadata, so the same modules serve every bundle: the client bundle's metadata already
     * carries only its form-phase formatters and public fields (decision: validate + form-phase
     * format are usable client-side), and lacks server-only defaults, so `applyDefaults` is inert
     * there. Emitted for every registered build (it never inspects the IR), like the codec/RPC
     * modules the compiler bakes.
     */
    emitBundleFiles: (_ir, ctx): EmitFile[] => {
        const files: EmitFile[] = [];
        for (const [name, mod] of Object.entries(EMITTED_SCHEMA_RUNTIME_MODULES)) {
            files.push({ path: path.posix.join(ctx.bundleDir, `${name}.js`), content: mod.js });
            files.push({ path: path.posix.join(ctx.bundleDir, `${name}.d.ts`), content: mod.dts });
        }
        return files;
    },
};

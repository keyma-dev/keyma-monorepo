import type { IRService, IRServiceMethod, IRType } from "@keyma/core/ir";
import { filterVisible } from "@keyma/core/util";
import { irTypeToTs, emitLiteral, mkRaw, relModuleSpecifier, type ServiceEmitDeps } from "@keyma/compiler/backend-js";

/** Bundle-relative module ref of the services file (sits at the bundle root). */
export const SERVICES_REF = "services";

export type { ServiceEmitDeps };

export type ServiceEmitFiles = { servicesJs: string; servicesDts: string };

// ── shared helpers ───────────────────────────────────────────────────────────

/** Core (array-unwrapped) reference/embedded target `name` of a type. */
function refTargetName(t: IRType): string | undefined {
    const inner = t.kind === "array" ? t.of : t;
    return inner.kind === "reference" || inner.kind === "embedded" ? inner.schema : undefined;
}

/** `name`s of every schema referenced by a method list's params/returns
 *  (needed for `.d.ts` type imports). */
function refTargetNamesOf(methods: readonly IRServiceMethod[]): Set<string> {
    const out = new Set<string>();
    for (const m of methods) {
        for (const p of m.params) {
            const s = refTargetName(p.type);
            if (s !== undefined) out.add(s);
        }
        if (m.returnType !== undefined) {
            const s = refTargetName(m.returnType);
            if (s !== undefined) out.add(s);
        }
    }
    return out;
}

/** `name`s of schemas referenced by RETURN types only — the client needs these
 *  as live classes (`refs` Map) to hydrate results. Inputs are plain objects. */
function returnTargetNamesOf(methods: readonly IRServiceMethod[]): Set<string> {
    const out = new Set<string>();
    for (const m of methods) {
        if (m.returnType === undefined) continue;
        const s = refTargetName(m.returnType);
        if (s !== undefined) out.add(s);
    }
    return out;
}

/** Build the `import` lines bringing referenced model classes into the services
 *  file. Targets are identities (`name`); resolve each to its class symbol/module. */
function buildModelImports(
    targetNames: ReadonlySet<string>,
    deps: ServiceEmitDeps,
    typeOnly: boolean,
): string[] {
    const bySpec = new Map<string, Set<string>>();
    for (const name of targetNames) {
        const symbol = deps.embeddedTypeNames.get(name);
        if (symbol === undefined) continue;
        const moduleRef = deps.schemaModule.get(symbol);
        if (moduleRef === undefined) continue;
        const spec = relModuleSpecifier(SERVICES_REF, moduleRef);
        if (!bySpec.has(spec)) bySpec.set(spec, new Set());
        bySpec.get(spec)!.add(symbol);
    }
    const kw = typeOnly ? "import type" : "import";
    return [...bySpec.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([spec, bindings]) => `${kw} { ${[...bindings].sort().join(", ")} } from "${spec}";`);
}

// ── services.js ──────────────────────────────────────────────────────────────

/** Per-method runtime metadata object (ready for `emitLiteral`). */
function methodMetadata(m: IRServiceMethod): Record<string, unknown> {
    const out: Record<string, unknown> = { name: m.name };
    if (m.visibility === "private") out["visibility"] = "private";
    out["params"] = m.params.map((p) => {
        // Only direct (non-array) schema params are validated server-side against a
        // single record — record the schema's runtime `name`.
        if (p.type.kind === "reference" || p.type.kind === "embedded") {
            return { name: p.name, schema: p.type.schema };
        }
        return { name: p.name };
    });
    if (m.returnType !== undefined) {
        const name = refTargetName(m.returnType);
        if (name !== undefined) {
            out["returnSchema"] = name;
            if (m.returnType.kind === "array") out["returnArray"] = true;
        }
    }
    return out;
}

function emitServiceClassJs(svc: IRService, deps: ServiceEmitDeps): string {
    const methods = filterVisible(svc.methods, deps.includePrivate);
    const meta: Record<string, unknown> = { name: svc.name };
    if (svc.visibility === "private") meta["visibility"] = "private";
    meta["methods"] = methods.map((m) => methodMetadata(m));

    // Client bundles carry a live `refs` Map (schema name → model class) for return hydration.
    if (!deps.includePrivate) {
        const names = returnTargetNamesOf(methods);
        if (names.size > 0) {
            const entries = [...names]
                .map((name) => {
                    const cls = deps.embeddedTypeNames.get(name) ?? name;
                    return `[${JSON.stringify(name)}, ${cls}]`;
                })
                .join(", ");
            meta["refs"] = mkRaw(`new Map([${entries}])`);
        }
    }

    return [
        `export class ${svc.sourceName} {}`,
        `${svc.sourceName}.service = Object.freeze(${emitLiteral(meta)});`,
        "",
    ].join("\n");
}

export function emitServicesJs(services: readonly IRService[], deps: ServiceEmitDeps): string {
    const shown = filterVisible(services, deps.includePrivate);
    // Value imports are only needed for the client `refs` Map (return schemas).
    const refSources = deps.includePrivate
        ? new Set<string>()
        : new Set(shown.flatMap((s) => [...returnTargetNamesOf(filterVisible(s.methods, deps.includePrivate))]));
    const imports = buildModelImports(refSources, deps, false);

    const blocks = shown.map((s) => emitServiceClassJs(s, deps));
    return [...imports, ...(imports.length > 0 ? [""] : []), blocks.join("\n")].join("\n");
}

// ── services.d.ts ────────────────────────────────────────────────────────────

/** A method's `.d.ts` return type. Always `Promise<T>` — remote calls are async,
 *  so every emitted signature forces an async implementation/usage. */
function methodReturnTs(m: IRServiceMethod, deps: ServiceEmitDeps): string {
    const ret = m.returnType ? irTypeToTs(m.returnType, deps.embeddedTypeNames) : "void";
    return `Promise<${ret}>`;
}

/** Server/library bundle: an abstract base class the application extends. Methods
 *  carry the injected `ctx` and async returns, so `override` impls are checked. */
function emitServiceClassDts(svc: IRService, deps: ServiceEmitDeps): string {
    const lines: string[] = [];
    lines.push(`export declare abstract class ${svc.sourceName} {`);
    lines.push(`    static readonly service: ServiceMetadata;`);
    for (const m of filterVisible(svc.methods, deps.includePrivate)) {
        const params = m.params.map((p) => `${p.name}: ${irTypeToTs(p.type, deps.embeddedTypeNames)}`);
        params.push("ctx: RequestContext");
        lines.push(`    abstract ${m.name}(${params.join(", ")}): ${methodReturnTs(m, deps)};`);
    }
    lines.push(`}`);
    return lines.join("\n");
}

/**
 * Client bundle: a branded abstract class. The abstract async method signatures
 * (data params only — `ctx` is server-injected) make the callable surface visible
 * and checkable in editors; the `ServiceBrand` carries the contract that drives
 * `Keyma.call(...)` argument/return inference. The runtime value is the emitted
 * `class` carrying `static service`.
 */
function emitServiceClientDts(svc: IRService, deps: ServiceEmitDeps): string {
    const methods = filterVisible(svc.methods, deps.includePrivate);
    const declName = `_${svc.sourceName}`;
    const lines: string[] = [];

    lines.push(`declare abstract class ${declName} {`);
    lines.push(`    static readonly service: ServiceMetadata;`);
    for (const m of methods) {
        const params = m.params.map((p) => `${p.name}: ${irTypeToTs(p.type, deps.embeddedTypeNames)}`).join(", ");
        lines.push(`    abstract ${m.name}(${params}): ${methodReturnTs(m, deps)};`);
    }
    lines.push(`}`);

    const brand = methods.map((m) => {
        const args = m.params.map((p) => `${p.name}: ${irTypeToTs(p.type, deps.embeddedTypeNames)}`).join("; ");
        const argsObj = args.length > 0 ? `{ ${args} }` : "{}";
        const ret = m.returnType ? irTypeToTs(m.returnType, deps.embeddedTypeNames) : "void";
        return `    ${m.name}: { args: ${argsObj}; ret: ${ret} };`;
    });
    lines.push(`export declare const ${svc.sourceName}: typeof ${declName} & { readonly __service?: {`);
    lines.push(...brand);
    lines.push(`} };`);
    return lines.join("\n");
}

export function emitServicesDts(services: readonly IRService[], deps: ServiceEmitDeps): string {
    const shown = filterVisible(services, deps.includePrivate);
    const allMethods = shown.flatMap((s) => filterVisible(s.methods, deps.includePrivate));
    const modelImports = buildModelImports(refTargetNamesOf(allMethods), deps, true);

    const lines: string[] = [];
    if (deps.includePrivate) {
        lines.push(`import type { ServiceMetadata, RequestContext } from "./types.js";`);
        lines.push(...modelImports);
        lines.push("");
        for (const svc of shown) {
            lines.push(emitServiceClassDts(svc, deps));
            lines.push("");
        }
    } else {
        lines.push(`import type { ServiceMetadata } from "./types.js";`);
        lines.push(...modelImports);
        lines.push("");
        for (const svc of shown) {
            lines.push(emitServiceClientDts(svc, deps));
            lines.push("");
        }
    }
    return lines.join("\n");
}

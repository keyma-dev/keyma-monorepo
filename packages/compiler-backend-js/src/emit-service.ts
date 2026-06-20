import type { IRService, IRServiceMethod, IRType } from "@keyma/ir";
import { irTypeToTs } from "./ir-type-to-ts.js";
import { emitLiteral, raw } from "./emit-literal.js";
import { relModuleSpecifier } from "./module-path.js";

/** Bundle-relative module ref of the services file (sits at the bundle root). */
export const SERVICES_REF = "services";

export type ServiceEmitDeps = {
    /** Include private services and private methods (server/library bundles). */
    includePrivate: boolean;
    /** sourceName → bundle-relative model module ref (e.g. "models/user/user"). */
    schemaModule: ReadonlyMap<string, string>;
    /** sourceName → TypeScript type name (for `.d.ts`). */
    embeddedTypeNames: ReadonlyMap<string, string>;
    /** sourceName → schema runtime name (the server's schemaMap key / refs key). */
    schemaName: ReadonlyMap<string, string>;
};

export type ServiceEmitFiles = { servicesJs: string; servicesDts: string };

// ── shared helpers ───────────────────────────────────────────────────────────

function visibleServices(services: readonly IRService[], includePrivate: boolean): IRService[] {
    return includePrivate ? [...services] : services.filter((s) => s.visibility === "public");
}

function visibleMethods(svc: IRService, includePrivate: boolean): IRServiceMethod[] {
    return includePrivate ? svc.methods : svc.methods.filter((m) => m.visibility === "public");
}

/** Core (array-unwrapped) reference/embedded target sourceName of a type. */
function refTargetSourceName(t: IRType): string | undefined {
    const inner = t.kind === "array" ? t.of : t;
    return inner.kind === "reference" || inner.kind === "embedded" ? inner.schema : undefined;
}

/** sourceNames of every schema referenced by a method list's params/returns
 *  (needed for `.d.ts` type imports). */
function refSourcesOf(methods: readonly IRServiceMethod[]): Set<string> {
    const out = new Set<string>();
    for (const m of methods) {
        for (const p of m.params) {
            const s = refTargetSourceName(p.type);
            if (s !== undefined) out.add(s);
        }
        if (m.returnType !== undefined) {
            const s = refTargetSourceName(m.returnType);
            if (s !== undefined) out.add(s);
        }
    }
    return out;
}

/** sourceNames of schemas referenced by RETURN types only — the client needs these
 *  as live classes (`refs` Map) to hydrate results. Inputs are plain objects. */
function returnSourcesOf(methods: readonly IRServiceMethod[]): Set<string> {
    const out = new Set<string>();
    for (const m of methods) {
        if (m.returnType === undefined) continue;
        const s = refTargetSourceName(m.returnType);
        if (s !== undefined) out.add(s);
    }
    return out;
}

/** Build the `import` lines bringing referenced model classes into the services file. */
function buildModelImports(
    sources: ReadonlySet<string>,
    deps: ServiceEmitDeps,
    typeOnly: boolean,
): string[] {
    const bySpec = new Map<string, Set<string>>();
    for (const src of sources) {
        const moduleRef = deps.schemaModule.get(src);
        if (moduleRef === undefined) continue;
        const binding = deps.embeddedTypeNames.get(src) ?? src;
        const spec = relModuleSpecifier(SERVICES_REF, moduleRef);
        if (!bySpec.has(spec)) bySpec.set(spec, new Set());
        bySpec.get(spec)!.add(binding);
    }
    const kw = typeOnly ? "import type" : "import";
    return [...bySpec.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([spec, bindings]) => `${kw} { ${[...bindings].sort().join(", ")} } from "${spec}";`);
}

// ── services.js ──────────────────────────────────────────────────────────────

/** Per-method runtime metadata object (ready for `emitLiteral`). */
function methodMetadata(m: IRServiceMethod, deps: ServiceEmitDeps): Record<string, unknown> {
    const out: Record<string, unknown> = { name: m.name };
    if (m.visibility === "private") out["visibility"] = "private";
    out["params"] = m.params.map((p) => {
        // Only direct (non-array) schema params are validated server-side against a
        // single record — record the schema's runtime name.
        if (p.type.kind === "reference" || p.type.kind === "embedded") {
            const name = deps.schemaName.get(p.type.schema);
            if (name !== undefined) return { name: p.name, schema: name };
        }
        return { name: p.name };
    });
    if (m.returnType !== undefined) {
        const src = refTargetSourceName(m.returnType);
        const name = src !== undefined ? deps.schemaName.get(src) : undefined;
        if (name !== undefined) {
            out["returnSchema"] = name;
            if (m.returnType.kind === "array") out["returnArray"] = true;
        }
    }
    return out;
}

function emitServiceClassJs(svc: IRService, deps: ServiceEmitDeps): string {
    const methods = visibleMethods(svc, deps.includePrivate);
    const meta: Record<string, unknown> = { name: svc.name };
    if (svc.visibility === "private") meta["visibility"] = "private";
    meta["methods"] = methods.map((m) => methodMetadata(m, deps));

    // Client bundles carry a live `refs` Map (schema name → model class) for return hydration.
    if (!deps.includePrivate) {
        const sources = returnSourcesOf(methods);
        if (sources.size > 0) {
            const entries = [...sources]
                .map((src) => {
                    const key = deps.schemaName.get(src) ?? src;
                    const cls = deps.embeddedTypeNames.get(src) ?? src;
                    return `[${JSON.stringify(key)}, ${cls}]`;
                })
                .join(", ");
            meta["refs"] = raw(`new Map([${entries}])`);
        }
    }

    return [
        `export class ${svc.sourceName} {}`,
        `${svc.sourceName}.service = Object.freeze(${emitLiteral(meta)});`,
        "",
    ].join("\n");
}

export function emitServicesJs(services: readonly IRService[], deps: ServiceEmitDeps): string {
    const visible = visibleServices(services, deps.includePrivate);
    // Value imports are only needed for the client `refs` Map (return schemas).
    const refSources = deps.includePrivate
        ? new Set<string>()
        : new Set(visible.flatMap((s) => [...returnSourcesOf(visibleMethods(s, deps.includePrivate))]));
    const imports = buildModelImports(refSources, deps, false);

    const blocks = visible.map((s) => emitServiceClassJs(s, deps));
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
    for (const m of visibleMethods(svc, deps.includePrivate)) {
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
    const methods = visibleMethods(svc, deps.includePrivate);
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
    const visible = visibleServices(services, deps.includePrivate);
    const allMethods = visible.flatMap((s) => visibleMethods(s, deps.includePrivate));
    const modelImports = buildModelImports(refSourcesOf(allMethods), deps, true);

    const lines: string[] = [];
    if (deps.includePrivate) {
        lines.push(`import type { ServiceMetadata, RequestContext } from "./types.js";`);
        lines.push(...modelImports);
        lines.push("");
        for (const svc of visible) {
            lines.push(emitServiceClassDts(svc, deps));
            lines.push("");
        }
    } else {
        lines.push(`import type { ServiceMetadata } from "./types.js";`);
        lines.push(...modelImports);
        lines.push("");
        for (const svc of visible) {
            lines.push(emitServiceClientDts(svc, deps));
            lines.push("");
        }
    }
    return lines.join("\n");
}

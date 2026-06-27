import type { IRService, IRServiceMethod, IRType } from "@keyma/core/ir";
import { filterVisible } from "@keyma/core/util";
import { irTypeToTs } from "./ir-type-to-ts.js";
import { emitLiteral, mkRaw } from "./emit-literal.js";
import { relModuleSpecifier } from "./module-path.js";
import type { ServiceEmitDeps } from "./emitter-registry.js";

// `@Service`/RPC is a base-language concern the compiler owns end-to-end: the bundle shell calls
// these emitters directly on `ir.services` (gated by visibility like classes). No domain pack
// participates — services emit identically for any (or no) registered domain.
//
// The shape is generated marshalling over a `Transport`, importing ONLY from the bundle-local
// baked RPC modules (./client.js, ./rpc.js, ./errors.js) — never from `@keyma/runtime`:
//   * Client bundle — a concrete `class UserService extends ServiceClient`; each method body is a
//     single `_call(...)` that encodes args, invokes the transport, unwraps the envelope, and
//     hydrates the return.
//   * Server bundle — an abstract base the app extends, carrying a generated `dispatch(method,
//     payload, ctx, encoding)` (decode args → call impl → encode result) and `static service`.

/** Bundle-relative module ref of the services file (sits at the bundle root). */
export const SERVICES_REF = "services";

export type ServiceEmitFiles = { servicesJs: string; servicesDts: string };

// Baked RPC modules the generated services import from (siblings to `services.js`).
const CLIENT_REF = "client";
const RPC_REF = "rpc";
const ERRORS_REF = "errors";
const TYPES_REF = "types";

// ── shared helpers ───────────────────────────────────────────────────────────

/** Core (array-unwrapped) target `name` of a type — the class a reference/embedded points at,
 *  or the class an `instance` is a value of. */
function refTargetName(t: IRType): string | undefined {
    const inner = t.kind === "array" ? t.of : t;
    if (inner.kind === "reference" || inner.kind === "embedded") return inner.target;
    if (inner.kind === "instance") return inner.name;
    return undefined;
}

/** `name`s of every class referenced by a method list's params AND returns — needed both as
 *  live classes (the `refs` Map that drives class-arg/return marshalling) and as `.d.ts` types. */
function classTargetNamesOf(methods: readonly IRServiceMethod[]): Set<string> {
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

/** Build `import` lines bringing referenced model classes into the services file. Targets are
 *  identities (`name`); resolve each to its class symbol/module. */
function buildModelImports(
    targetNames: ReadonlySet<string>,
    deps: ServiceEmitDeps,
    typeOnly: boolean,
): string[] {
    const bySpec = new Map<string, Set<string>>();
    for (const name of targetNames) {
        const symbol = deps.embeddedTypeNames.get(name);
        if (symbol === undefined) continue;
        const moduleRef = deps.classModule.get(symbol);
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

/** Per-service `refs` const name + its `new Map([...])` initializer (model `name` → class). */
function refsConstName(svc: IRService): string {
    return `${svc.sourceName}__refs`;
}
function emitRefsConst(svc: IRService, targetNames: ReadonlySet<string>, deps: ServiceEmitDeps): string {
    const entries = [...targetNames]
        .map((name) => ({ name, symbol: deps.embeddedTypeNames.get(name) }))
        .filter((e): e is { name: string; symbol: string } => e.symbol !== undefined)
        .map((e) => `[${JSON.stringify(e.name)}, ${e.symbol}]`)
        .join(", ");
    return `const ${refsConstName(svc)} = new Map([${entries}]);`;
}

/** A method's param/return value type as a codec literal (the IRType is structurally the codec
 *  FieldType — `reference`/`embedded` use `target`, `instance` uses `name`). */
function typeLiteral(type: IRType): string {
    return emitLiteral(type as unknown as Record<string, unknown>);
}

// ── services.js ──────────────────────────────────────────────────────────────

/** The slim `static service` metadata literal (name + per-method name/visibility for host
 *  resolution + gating). The host never inspects arg/return types. */
function serviceMetadataLiteral(svc: IRService, methods: readonly IRServiceMethod[]): string {
    const meta: Record<string, unknown> = { name: svc.name };
    if (svc.visibility === "private") meta["visibility"] = "private";
    meta["methods"] = methods.map((m) => {
        const mm: Record<string, unknown> = { name: m.name };
        if (m.visibility === "private") mm["visibility"] = "private";
        return mm;
    });
    return emitLiteral(meta);
}

/** Client bundle: a concrete `class <Svc> extends ServiceClient`. Each method marshals via the
 *  inherited `_call(service, method, args, returnType, refs)`. */
function emitServiceClientJs(svc: IRService, deps: ServiceEmitDeps): string {
    const methods = filterVisible(svc.methods, deps.includePrivate);
    const refs = refsConstName(svc);
    const lines: string[] = [];
    lines.push(emitRefsConst(svc, classTargetNamesOf(methods), deps));
    lines.push("");
    lines.push(`export class ${svc.sourceName} extends ServiceClient {`);
    for (const m of methods) {
        const params = m.params.map((p) => p.name).join(", ");
        const args = m.params
            .map((p) => `{ name: ${JSON.stringify(p.name)}, type: ${typeLiteral(p.type)}, value: ${p.name} }`)
            .join(", ");
        const ret = m.returnType !== undefined ? typeLiteral(m.returnType) : "undefined";
        lines.push(`    ${m.name}(${params}) {`);
        lines.push(`        return this._call(${JSON.stringify(svc.name)}, ${JSON.stringify(m.name)}, [${args}], ${ret}, ${refs});`);
        lines.push(`    }`);
    }
    lines.push(`}`);
    lines.push("");
    return lines.join("\n");
}

/** Server bundle: an abstract base (the app extends it) carrying the generated `dispatch` switch
 *  + `static service`. The app's overrides supply the method bodies. */
function emitServiceServerJs(svc: IRService, deps: ServiceEmitDeps): string {
    const methods = filterVisible(svc.methods, deps.includePrivate);
    const refs = refsConstName(svc);
    const lines: string[] = [];
    lines.push(emitRefsConst(svc, classTargetNamesOf(methods), deps));
    lines.push("");
    lines.push(`export class ${svc.sourceName} {`);
    lines.push(`    async dispatch(method, payload, ctx, encoding) {`);
    lines.push(`        switch (method) {`);
    for (const m of methods) {
        const paramSpecs = m.params
            .map((p) => `{ name: ${JSON.stringify(p.name)}, type: ${typeLiteral(p.type)} }`)
            .join(", ");
        const ret = m.returnType !== undefined ? typeLiteral(m.returnType) : "undefined";
        const callArgs = [...m.params.map((_, i) => `args[${i}]`), "ctx"].join(", ");
        lines.push(`            case ${JSON.stringify(m.name)}: {`);
        lines.push(`                if (typeof this.${m.name} !== "function") throw new KeymaError("METHOD_NOT_IMPLEMENTED", ${JSON.stringify(`Service "${svc.name}" does not implement "${m.name}"`)});`);
        lines.push(`                const args = decodeArgs(encoding, payload, [${paramSpecs}], ${refs});`);
        lines.push(`                return encodeResult(encoding, await this.${m.name}(${callArgs}), ${ret}, ${refs});`);
        lines.push(`            }`);
    }
    lines.push(`            default:`);
    lines.push(`                throw new KeymaError("METHOD_NOT_FOUND", \`Unknown method "\${method}" on service ${JSON.stringify(svc.name)}\`);`);
    lines.push(`        }`);
    lines.push(`    }`);
    lines.push(`}`);
    lines.push(`${svc.sourceName}.service = Object.freeze(${serviceMetadataLiteral(svc, methods)});`);
    lines.push("");
    return lines.join("\n");
}

export function emitServicesJs(services: readonly IRService[], deps: ServiceEmitDeps): string {
    const shown = filterVisible(services, deps.includePrivate);
    const allMethods = shown.flatMap((s) => filterVisible(s.methods, deps.includePrivate));
    const modelImports = buildModelImports(classTargetNamesOf(allMethods), deps, false);

    const runtimeImports = deps.includePrivate
        ? [
              `import { decodeArgs, encodeResult } from "${relModuleSpecifier(SERVICES_REF, RPC_REF)}";`,
              `import { KeymaError } from "${relModuleSpecifier(SERVICES_REF, ERRORS_REF)}";`,
          ]
        : [`import { ServiceClient } from "${relModuleSpecifier(SERVICES_REF, CLIENT_REF)}";`];

    const blocks = shown.map((s) => (deps.includePrivate ? emitServiceServerJs(s, deps) : emitServiceClientJs(s, deps)));
    return [...runtimeImports, ...modelImports, "", blocks.join("\n")].join("\n");
}

// ── services.d.ts ────────────────────────────────────────────────────────────

/** A method's `.d.ts` return type. Always `Promise<T>` — remote calls are async, so every emitted
 *  signature forces an async implementation/usage. */
function methodReturnTs(m: IRServiceMethod, deps: ServiceEmitDeps): string {
    const ret = m.returnType ? irTypeToTs(m.returnType, deps.embeddedTypeNames) : "void";
    return `Promise<${ret}>`;
}

/** Server/library bundle: an abstract base the application extends. Data methods carry the
 *  injected `ctx` last; the generated `dispatch` is concrete. */
function emitServiceServerDts(svc: IRService, deps: ServiceEmitDeps): string {
    const lines: string[] = [];
    lines.push(`export declare abstract class ${svc.sourceName} {`);
    lines.push(`    static readonly service: ServiceMetadata;`);
    for (const m of filterVisible(svc.methods, deps.includePrivate)) {
        const params = m.params.map((p) => `${p.name}: ${irTypeToTs(p.type, deps.embeddedTypeNames)}`);
        params.push("ctx: RequestContext");
        lines.push(`    abstract ${m.name}(${params.join(", ")}): ${methodReturnTs(m, deps)};`);
    }
    lines.push(`    dispatch(method: string, payload: unknown, ctx: RequestContext, encoding: WireEncoding): Promise<unknown>;`);
    lines.push(`}`);
    return lines.join("\n");
}

/** Client bundle: a concrete class bound to a `Transport` via `ServiceClient`. Data methods take
 *  the declared params only (`ctx` is server-injected) and return `Promise<T>`. */
function emitServiceClientDts(svc: IRService, deps: ServiceEmitDeps): string {
    const lines: string[] = [];
    lines.push(`export declare class ${svc.sourceName} extends ServiceClient {`);
    for (const m of filterVisible(svc.methods, deps.includePrivate)) {
        const params = m.params.map((p) => `${p.name}: ${irTypeToTs(p.type, deps.embeddedTypeNames)}`).join(", ");
        lines.push(`    ${m.name}(${params}): ${methodReturnTs(m, deps)};`);
    }
    lines.push(`}`);
    return lines.join("\n");
}

export function emitServicesDts(services: readonly IRService[], deps: ServiceEmitDeps): string {
    const shown = filterVisible(services, deps.includePrivate);
    const allMethods = shown.flatMap((s) => filterVisible(s.methods, deps.includePrivate));
    const modelImports = buildModelImports(classTargetNamesOf(allMethods), deps, true);

    const lines: string[] = [];
    if (deps.includePrivate) {
        lines.push(`import type { ServiceMetadata, RequestContext, WireEncoding } from "${relModuleSpecifier(SERVICES_REF, TYPES_REF)}";`);
        lines.push(...modelImports);
        lines.push("");
        for (const svc of shown) {
            lines.push(emitServiceServerDts(svc, deps));
            lines.push("");
        }
    } else {
        lines.push(`import { ServiceClient } from "${relModuleSpecifier(SERVICES_REF, CLIENT_REF)}";`);
        lines.push(...modelImports);
        lines.push("");
        for (const svc of shown) {
            lines.push(emitServiceClientDts(svc, deps));
            lines.push("");
        }
    }
    return lines.join("\n");
}

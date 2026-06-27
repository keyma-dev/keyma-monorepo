import type { IRService, IRServiceMethod, IRType } from "@keyma/core/ir";
import { filterVisible } from "@keyma/core/util";
import { emitLiteral } from "./emit-literal.js";
import { pythonRelImport } from "./module-path.js";
import { EMITTED_PY_RUNTIME_MODULE } from "./emitted-runtime.js";

// `@Service`/RPC is a base-language concern the compiler owns end-to-end: the bundle shell calls
// these emitters directly on `ir.services` (gated by visibility like classes). No domain pack
// participates — services emit identically for any (or no) registered domain. Both the server
// abstract base (+ generated `dispatch`) and the client class delegate marshalling to the
// bundle-local baked runtime module (the codec + RPC stack), so generated code imports no
// `keyma-runtime` package.

/** Bundle-relative module ref of the services file (sits at the bundle root). */
export const SERVICES_REF = "services";

export type ServiceEmitDeps = {
    /** Server/library bundles emit the abstract base + `dispatch`; client bundles emit the
     *  transport-bound client class. */
    includePrivate: boolean;
    /** sourceName → bundle-relative module ref (e.g. "src/user/user"). */
    classModule: ReadonlyMap<string, string>;
    /** Reference/embedded/instance target `name` → emitted Python class (`sourceName`). */
    classNameByName: ReadonlyMap<string, string>;
};

// ── shared helpers ───────────────────────────────────────────────────────────

/** Core (array-unwrapped) target `name` of a type — the class a reference/embedded points at,
 *  or the class an `instance` is a value of. */
function refTargetName(t: IRType): string | undefined {
    const inner = t.kind === "array" ? t.of : t;
    if (inner.kind === "reference" || inner.kind === "embedded") return inner.target;
    if (inner.kind === "instance") return inner.name;
    return undefined;
}

/** `name`s of every class referenced by a method list's params/returns. */
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

/** Python literal of a method param descriptor list: `[("name", {<ir-type>}), ...]`. The IR type
 *  dict (with `kind` + `target`/`name`/`idType`/`of`/…) is exactly what the runtime marshaller
 *  consumes. */
function paramsLiteral(m: IRServiceMethod): string {
    const parts = m.params.map((p) => `(${JSON.stringify(p.name)}, ${emitLiteral(p.type)})`);
    return `[${parts.join(", ")}]`;
}

/** Python literal of a method return-type descriptor (the IR type dict, or `None` for void). */
function returnLiteral(m: IRServiceMethod): string {
    return m.returnType !== undefined ? emitLiteral(m.returnType) : "None";
}

/** The `from <prefix><module> import …` lines bringing referenced model classes into the
 *  services file. Targets are identities (`name`); resolve each to its class symbol + module. */
function buildModelImports(targetNames: ReadonlySet<string>, deps: ServiceEmitDeps): string[] {
    const bySpec = new Map<string, Set<string>>();
    for (const name of targetNames) {
        const symbol = deps.classNameByName.get(name);
        if (symbol === undefined) continue;
        const moduleRef = deps.classModule.get(symbol);
        if (moduleRef === undefined) continue;
        const { prefix, module } = pythonRelImport(SERVICES_REF, moduleRef);
        const spec = `from ${prefix}${module} import`;
        if (!bySpec.has(spec)) bySpec.set(spec, new Set());
        bySpec.get(spec)!.add(symbol);
    }
    return [...bySpec.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([spec, bindings]) => `${spec} ${[...bindings].sort().join(", ")}`);
}

/** The `_REFS = {…}` dict literal mapping each referenced target `name` to its emitted class,
 *  for the marshaller to hydrate/encode class-typed values. */
function refsDict(targetNames: ReadonlySet<string>, deps: ServiceEmitDeps): string {
    const entries = [...targetNames]
        .map((name) => [name, deps.classNameByName.get(name)] as const)
        .filter((e): e is readonly [string, string] => e[1] !== undefined)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, symbol]) => `${JSON.stringify(name)}: ${symbol}`);
    return `{${entries.join(", ")}}`;
}

/** Relative-import prefix from the services file to the bundle-local baked runtime module. */
function runtimeImport(names: readonly string[]): string {
    const { prefix, module } = pythonRelImport(SERVICES_REF, EMITTED_PY_RUNTIME_MODULE);
    return `from ${prefix}${module} import ${names.join(", ")}`;
}

// ── Server bundle: abstract base + generated dispatch ──────────────────────────

function emitServiceServer(svc: IRService, deps: ServiceEmitDeps): string {
    const methods = filterVisible(svc.methods, deps.includePrivate);
    const lines: string[] = [];

    lines.push(`class ${svc.sourceName}:`);
    lines.push(`    """Generated service base — extend it and implement the abstract methods, then`);
    lines.push(`    register an instance with a ServiceHost."""`);
    lines.push("");
    lines.push(`    service_name = ${JSON.stringify(svc.name)}`);
    if (svc.visibility === "private") lines.push(`    service_private = True`);
    const methodMeta = methods
        .map((m) => `${JSON.stringify(m.name)}: {"private": ${m.visibility === "private" ? "True" : "False"}}`)
        .join(", ");
    lines.push(`    _methods = {${methodMeta}}`);

    // Abstract methods — overridden by the application; the unimplemented default surfaces
    // METHOD_NOT_IMPLEMENTED through the envelope. `ctx` is injected as the last argument.
    for (const m of methods) {
        const params = ["self", ...m.params.map((p) => p.name), "ctx"].join(", ");
        lines.push("");
        lines.push(`    async def ${m.name}(${params}):`);
        lines.push(`        raise KeymaError(METHOD_NOT_IMPLEMENTED, "${svc.sourceName}.${m.name} is not implemented")`);
    }

    // The generated dispatch: decode args (positional in binary, by name in JSON), call the impl
    // (awaiting a coroutine result), encode the return payload. The host stays type-agnostic.
    lines.push("");
    lines.push(`    async def dispatch(self, method, payload, ctx, encoding):`);
    for (const m of methods) {
        // `*args` unpacks the decoded params positionally; `ctx` is injected last.
        lines.push(`        if method == ${JSON.stringify(m.name)}:`);
        lines.push(`            args = decode_args(encoding, ${paramsLiteral(m)}, payload, _REFS)`);
        lines.push(`            result = self.${m.name}(*args, ctx)`);
        lines.push(`            if inspect.isawaitable(result):`);
        lines.push(`                result = await result`);
        lines.push(`            return encode_result(encoding, ${returnLiteral(m)}, result, _REFS)`);
    }
    lines.push(`        raise KeymaError(METHOD_NOT_FOUND, f"Method '{method}' not found")`);

    return lines.join("\n");
}

// ── Client bundle: transport-bound client class ────────────────────────────────

function emitServiceClient(svc: IRService, deps: ServiceEmitDeps): string {
    const methods = filterVisible(svc.methods, deps.includePrivate);
    const lines: string[] = [];

    lines.push(`class ${svc.sourceName}(ServiceClient):`);
    lines.push(`    """Generated RPC client — \`${svc.sourceName}(transport)\`; methods are \`async def\`."""`);
    lines.push("");
    lines.push(`    service_name = ${JSON.stringify(svc.name)}`);

    for (const m of methods) {
        const params = ["self", ...m.params.map((p) => p.name)].join(", ");
        const valueList = `[${m.params.map((p) => p.name).join(", ")}]`;
        lines.push("");
        lines.push(`    async def ${m.name}(${params}):`);
        lines.push(`        args = encode_args(self._encoding, ${paramsLiteral(m)}, ${valueList}, _REFS)`);
        lines.push(`        result = await self._invoke(${JSON.stringify(m.name)}, args)`);
        lines.push(`        return decode_result(self._encoding, ${returnLiteral(m)}, result, _REFS)`);
    }

    return lines.join("\n");
}

// ── services.py ────────────────────────────────────────────────────────────────

/** Emit the bundle's `services.py`: server abstract bases + `dispatch` (server/library bundles) or
 *  transport-bound client classes (client bundle). Returns "" when no service is visible. */
export function emitServicesPython(services: readonly IRService[], deps: ServiceEmitDeps): string {
    const shown = filterVisible(services, deps.includePrivate);
    if (shown.length === 0) return "";

    const allMethods = shown.flatMap((s) => filterVisible(s.methods, deps.includePrivate));
    const targetNames = refTargetNamesOf(allMethods);

    const header: string[] = ["from __future__ import annotations"];
    if (deps.includePrivate) {
        header.push("import inspect");
        header.push(
            runtimeImport(["KeymaError", "METHOD_NOT_FOUND", "METHOD_NOT_IMPLEMENTED", "decode_args", "encode_result"]),
        );
    } else {
        header.push(runtimeImport(["ServiceClient", "encode_args", "decode_result"]));
    }
    header.push(...buildModelImports(targetNames, deps));

    const blocks = shown.map((s) => (deps.includePrivate ? emitServiceServer(s, deps) : emitServiceClient(s, deps)));

    return [...header, "", "", `_REFS = ${refsDict(targetNames, deps)}`, "", "", blocks.join("\n\n\n"), ""].join("\n");
}

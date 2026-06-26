import ts from "typescript";
import type { IRMethod, IRFunctionParam, IRStatement, IRType, IRDiagnostic } from "@keyma/core/ir";
import { mkError, KEYMA082, KEYMA092 } from "./diagnostics.js";
import { getLocation } from "./util.js";
import { mapTypeNode, type TypeMapContext } from "./map-type.js";
import { lowerStatement, type PortableExprCtx, type FnRefVerdict } from "./lower-portable-expr.js";
import type { EnumInfo } from "./discover-enums.js";

/**
 * Dependencies for lowering a method/setter behavior. Mirrors the field-extraction
 * context but threads `classifyFunction` so a behavior body may call project-local
 * utility functions (compiled into `functionDeclarations`), like validator bodies.
 */
export type MethodLowerCtx = {
    checker: ts.TypeChecker;
    dslModuleName: string;
    schemaClassNames: ReadonlySet<string>;
    enums?: ReadonlyMap<string, EnumInfo>;
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
    classifyFunction?: (ident: ts.Identifier) => FnRefVerdict;
};

/** Lower a plain instance method to an `IRMethod` behavior (`kind: "method"`). */
export function lowerMethod(
    member: ts.MethodDeclaration,
    name: string,
    visibility: "public" | "private",
    ctx: MethodLowerCtx,
): IRMethod | null {
    if (!isPortableCallable(member, name, ctx)) return null;

    const typeMapCtx = mkTypeMapCtx(ctx);
    const params = lowerParams(member.parameters, name, typeMapCtx, ctx);
    if (params === null) return null;

    // Return type: an explicit annotation is required; `void` → no IR return type.
    if (member.type === undefined) {
        ctx.diagnostics.push(mkError(
            KEYMA092,
            `Method "${name}" must declare an explicit return type (use \`: void\` when it returns nothing)`,
            getLocation(member, ctx.sourceFile),
        ));
        return null;
    }
    let returnType: IRType | undefined;
    if (member.type.kind !== ts.SyntaxKind.VoidKeyword) {
        const mapped = mapAnnotated(member.type, typeMapCtx, ctx);
        if (mapped === null) return null;
        returnType = mapped;
    }

    const statements = lowerBody(member, ctx);
    const method: IRMethod = {
        name,
        kind: "method",
        params,
        statements,
        visibility,
        source: getLocation(member, ctx.sourceFile),
    };
    if (returnType !== undefined) method.returnType = returnType;
    return method;
}

/**
 * Lower just the SIGNATURE of a method — its typed parameters and return type —
 * without lowering a body. Used for `@Service` contracts, whose methods are
 * abstract (no body) and may be `async`/`Promise<T>` at the implementation site.
 * Unlike {@link lowerMethod}, this does NOT reject async (no `isPortableCallable`)
 * and peels a `Promise<...>` return wrapper. Returns `null` on a type-mapping
 * error (a diagnostic is pushed). A `void`/`Promise<void>` return yields no
 * `returnType`. Parameter types use the bare-class-reference mapping (a bare
 * `@Schema` class means the whole record).
 */
export function lowerSignature(
    member: ts.MethodDeclaration,
    name: string,
    ctx: MethodLowerCtx,
): { params: IRFunctionParam[]; returnType?: IRType } | null {
    const typeMapCtx = mkTypeMapCtx(ctx);
    const params = lowerParams(member.parameters, name, typeMapCtx, ctx);
    if (params === null) return null;

    if (member.type === undefined) {
        ctx.diagnostics.push(mkError(
            KEYMA092,
            `Service method "${name}" must declare an explicit return type (use \`: void\` when it returns nothing)`,
            getLocation(member, ctx.sourceFile),
        ));
        return null;
    }

    const peeled = peelPromise(member.type);
    if (peeled.kind === ts.SyntaxKind.VoidKeyword) {
        return { params };
    }
    const mapped = mapAnnotated(peeled, typeMapCtx, ctx);
    if (mapped === null) return null;
    return { params, returnType: mapped };
}

/** Unwrap a `Promise<T>` return annotation to `T`; pass other nodes through. */
function peelPromise(t: ts.TypeNode): ts.TypeNode {
    if (
        ts.isTypeReferenceNode(t) &&
        ts.isIdentifier(t.typeName) &&
        t.typeName.text === "Promise" &&
        t.typeArguments?.length === 1
    ) {
        return t.typeArguments[0]!;
    }
    return t;
}

/** Lower a setter to an `IRMethod` behavior (`kind: "setter"`, one typed value param). */
export function lowerSetter(
    member: ts.SetAccessorDeclaration,
    name: string,
    visibility: "public" | "private",
    ctx: MethodLowerCtx,
): IRMethod | null {
    const typeMapCtx = mkTypeMapCtx(ctx);
    // TypeScript guarantees a setter declares exactly one parameter.
    const params = lowerParams(member.parameters, name, typeMapCtx, ctx);
    if (params === null) return null;

    const statements = lowerBody(member, ctx);
    return {
        name,
        kind: "setter",
        params,
        statements,
        visibility,
        source: getLocation(member, ctx.sourceFile),
    };
}

/** Reject async/generator behaviors — their bodies are not part of the portable subset. */
function isPortableCallable(member: ts.MethodDeclaration, name: string, ctx: MethodLowerCtx): boolean {
    const isAsync = (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Async) !== 0;
    if (isAsync || member.asteriskToken !== undefined) {
        ctx.diagnostics.push(mkError(
            KEYMA082,
            `Method "${name}" is async/generator, which is not portable — behaviors must be plain synchronous methods`,
            getLocation(member, ctx.sourceFile),
        ));
        return false;
    }
    return true;
}

function mkTypeMapCtx(ctx: MethodLowerCtx): TypeMapContext {
    return {
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        schemaClassNames: ctx.schemaClassNames,
        ...(ctx.enums !== undefined && { enums: ctx.enums }),
        bareClassInstance: true,
        diagnostics: ctx.diagnostics,
        sourceFile: ctx.sourceFile,
    };
}

function lowerParams(
    parameters: ts.NodeArray<ts.ParameterDeclaration>,
    methodName: string,
    typeMapCtx: TypeMapContext,
    ctx: MethodLowerCtx,
): IRFunctionParam[] | null {
    const result: IRFunctionParam[] = [];
    for (const p of parameters) {
        const pname = ts.isIdentifier(p.name) ? p.name.text : "_";
        if (p.type === undefined) {
            ctx.diagnostics.push(mkError(
                KEYMA092,
                `Parameter "${pname}" of "${methodName}" must declare an explicit type`,
                getLocation(p, ctx.sourceFile),
            ));
            return null;
        }
        const mapped = mapAnnotated(p.type, typeMapCtx, ctx);
        if (mapped === null) return null;
        result.push({ name: pname, type: mapped });
    }
    return result;
}

function mapAnnotated(typeNode: ts.TypeNode, typeMapCtx: TypeMapContext, ctx: MethodLowerCtx): IRType | null {
    const result = mapTypeNode(typeNode, typeMapCtx);
    if ("diag" in result) {
        ctx.diagnostics.push(result.diag);
        return null;
    }
    return result.type;
}

function lowerBody(
    member: ts.MethodDeclaration | ts.SetAccessorDeclaration,
    ctx: MethodLowerCtx,
): IRStatement[] {
    const body = member.body;
    if (body === undefined) return [];
    const exprCtx: PortableExprCtx = {
        diagnostics: ctx.diagnostics,
        sourceFile: ctx.sourceFile,
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        schemaClassNames: ctx.schemaClassNames,
        // refMode defaults to "params": `this.x` → field, bare names → identifier.
        allowAssign: true,
        ...(ctx.classifyFunction !== undefined ? { classifyFunction: ctx.classifyFunction } : {}),
    };
    const statements: IRStatement[] = [];
    for (const s of body.statements) {
        const irStmt = lowerStatement(s, exprCtx);
        if (irStmt !== null) statements.push(irStmt);
    }
    return statements;
}

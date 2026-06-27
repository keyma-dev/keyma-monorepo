import ts from "typescript";
import path from "node:path";
import type { IRDiagnostic } from "@keyma/core/ir";
import {
    createProgram,
    DEFAULT_COMPILER_OPTIONS,
    lowerGetterBody,
    type PortableExprCtx,
    type MethodLowerCtx,
    type GetterLowerDeps,
} from "../../src/frontend-ts/index.js";

export type Built = { program: ts.Program; sf: ts.SourceFile; checker: ts.TypeChecker };

let counter = 0;

/** Build an in-memory `ts.Program` + checker over a single source string. */
export function build(code: string): Built {
    const fileName = path.resolve(`__frontend_test_${counter++}.ts`);
    const virtualFiles = new Map([[fileName, code]]);
    const program = createProgram([fileName], DEFAULT_COMPILER_OPTIONS, { virtualFiles });
    const sf = program.getSourceFile(fileName);
    if (sf === undefined) throw new Error("virtual source file was not created");
    return { program, sf, checker: program.getTypeChecker() };
}

/** A params-mode portable context (assignment enabled by default, like a method body). */
export function portableCtx(b: Built, diagnostics: IRDiagnostic[], opts?: Partial<PortableExprCtx>): PortableExprCtx {
    return {
        diagnostics,
        sourceFile: b.sf,
        checker: b.checker,
        dslModuleName: "@keyma/schema/dsl",
        classNames: new Set<string>(),
        allowAssign: true,
        ...opts,
    };
}

export function methodCtx(b: Built, diagnostics: IRDiagnostic[]): MethodLowerCtx {
    return {
        checker: b.checker,
        dslModuleName: "@keyma/schema/dsl",
        classNames: new Set<string>(),
        diagnostics,
        sourceFile: b.sf,
    };
}

export function findFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
    for (const s of sf.statements) {
        if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s;
    }
    throw new Error(`function "${name}" not found`);
}

export function findClass(sf: ts.SourceFile, name: string): ts.ClassDeclaration {
    for (const s of sf.statements) {
        if (ts.isClassDeclaration(s) && s.name?.text === name) return s;
    }
    throw new Error(`class "${name}" not found`);
}

export function classMethod(cls: ts.ClassDeclaration, name: string): ts.MethodDeclaration {
    for (const m of cls.members) {
        if (ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === name) return m;
    }
    throw new Error(`method "${name}" not found`);
}

export function classGetter(cls: ts.ClassDeclaration, name: string): ts.GetAccessorDeclaration {
    for (const m of cls.members) {
        if (ts.isGetAccessorDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === name) return m;
    }
    throw new Error(`getter "${name}" not found`);
}

export function classSetter(cls: ts.ClassDeclaration, name: string): ts.SetAccessorDeclaration {
    for (const m of cls.members) {
        if (ts.isSetAccessorDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === name) return m;
    }
    throw new Error(`setter "${name}" not found`);
}

/** Dependencies for lowering a computed getter body (the field-reference portable mode). */
export function getterDeps(b: Built, diagnostics: IRDiagnostic[]): GetterLowerDeps {
    return {
        diagnostics,
        sourceFile: b.sf,
        checker: b.checker,
        dslModuleName: "@keyma/schema/dsl",
        classNames: new Set<string>(),
    };
}

/**
 * Lower a single computed getter's body (built from a one-class source) and return the
 * lowered statement list — the common shape for getter-expression tests. Throws on a
 * missing class/getter; pushed diagnostics surface through `diags`.
 */
export function lowerGetter(b: Built, className: string, getterName: string, diags: IRDiagnostic[]) {
    return lowerGetterBody(classGetter(findClass(b.sf, className), getterName), getterDeps(b, diags));
}

export function classCtor(cls: ts.ClassDeclaration): ts.ConstructorDeclaration {
    for (const m of cls.members) {
        if (ts.isConstructorDeclaration(m)) return m;
    }
    throw new Error("constructor not found");
}

/** Depth-first search for the first node matching `pred`. */
export function findFirst<T extends ts.Node>(node: ts.Node, pred: (n: ts.Node) => n is T): T {
    let found: T | undefined;
    const visit = (n: ts.Node): void => {
        if (found !== undefined) return;
        if (pred(n)) { found = n; return; }
        ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
    if (found === undefined) throw new Error("matching node not found");
    return found;
}

export function hasCode(diags: readonly IRDiagnostic[], code: string): boolean {
    return diags.some((d) => d.code === code);
}

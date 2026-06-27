export { compile, compileVirtual } from "./compile.js";
export type { FrontendConfig, CompileResult } from "./compile.js";

// The frontend extension seam. A domain implements a declarative `FrontendDomain` and the CLI
// registers it; `@keyma/compiler` references no domain by name. The compiler owns the driver
// (base IR, validation, normalization, tags, functions, enums); a domain contributes decorators
// + per-class/program hooks.
export { FrontendExtensionRegistry } from "./extension-registry.js";
export type {
    FrontendDomain,
    DomainDecorator,
    DomainBaseContext,
    DomainContext,
    HandlerContext,
} from "./extension-registry.js";

// The per-class base-IR builder (domain-neutral) + the class-decorator option parser.
export { lowerClass } from "./lower-class.js";
export type { LowerClassResult, LowerClassContext, DecoratorRecognizer } from "./lower-class.js";

// Program construction.
export { createProgram, DEFAULT_COMPILER_OPTIONS } from "./program.js";

// ── Generic, domain-neutral lowering machinery ──────────────────────────────────
// Exported so domain frontends build their pipeline on the same TS-AST helpers, use-site
// function resolver, enum discovery, and the portable expression/statement/body lowering
// engine. None of this is domain-specific.
export {
    getLocation,
    resolveAlias,
    getImportModuleSpecifier,
    isFromModule,
    isCoreDslSymbol,
    isResolvedCoreDsl,
    entityNameText,
    numericLiteralValue,
    stringLiteralValue,
    booleanLiteralValue,
} from "./util.js";

// Neutral class-decorator helpers (find a named class-level `@Service`/domain decorator,
// parse its object-literal options) shared by the base service pass and any domain — one
// parser for all class decorators.
export { findKeymaClassDecorator, extractDecoratorOptions } from "./decorator.js";
export type { DecoratorOptions } from "./decorator.js";

export { discoverEnums } from "./discover-enums.js";
export type { EnumInfo } from "./discover-enums.js";

// ── Base-language frontend passes (domain-neutral) ──────────────────────────────
// Inheritance validation, binary tag assignment, name normalization, and local-enum
// collection are base-language concerns: they read only the domain-neutral core IR
// (`extends`/fields/visibility/types). Exported so a domain frontend (or the compiler
// driver) composes them. A domain enriches `extensions[domainId]`; these never read it.
export { checkInheritance } from "./check-inheritance.js";
export type { InheritanceContext } from "./check-inheritance.js";
export { checkDuplicateNames, checkVisibilityLeaks, checkPublicSurface } from "./base-checks.js";
export { assignTags, stripTagHints, MAX_TAG } from "./assign-tags.js";
export type { RawTaggedField, AssignTagsResult } from "./assign-tags.js";
export { normalizeClassNames } from "./normalize-names.js";
export { collectLocalAndUsedEnums } from "./collect-enums.js";

// The generic TS-type → IR-type mapper. Shared by a domain's field extraction and the
// generic method/function lowering, so it stays domain-neutral in the compiler.
export { mapTypeNode, inferIRTypeFromType } from "./map-type.js";
export type { TypeMapContext, MapTypeResult } from "./map-type.js";

export { createFunctionCollector } from "./lower-function.js";
export type { FunctionCollector, FunctionCollectorDeps } from "./lower-function.js";

export { lowerGetterBody } from "./lower-expression.js";
export type { GetterLowerDeps } from "./lower-expression.js";

export { lowerMethod, lowerSignature, lowerSetter, lowerConstructor, lowerDestructor, peelPromise } from "./lower-method.js";
export type { MethodLowerCtx } from "./lower-method.js";

export { lowerExpr, lowerStatement, lowerStatements, lowerBlock } from "./lower-portable-expr.js";
export type { FnRefVerdict, PortableExprCtx, BodyLowerCtx } from "./lower-portable-expr.js";

// Diagnostic constructors + the portable-lowering KEYMA#### codes owned by the compiler.
export * from "./diagnostics.js";

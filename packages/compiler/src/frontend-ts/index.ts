export { compile, compileVirtual } from "./compile.js";
export type { FrontendConfig, CompileResult } from "./compile.js";

// The frontend extension seam. A domain (e.g. `@keyma/schema/frontend-ts`) implements a
// `FrontendDomain` and the CLI registers it; `@keyma/compiler` references no domain by name.
export { FrontendExtensionRegistry } from "./extension-registry.js";
export type { FrontendDomain, FrontendDomainContext, FrontendContribution } from "./extension-registry.js";

// Program construction.
export { createProgram, DEFAULT_COMPILER_OPTIONS } from "./program.js";

// ── Generic, domain-neutral lowering machinery ──────────────────────────────────
// Exported so domain frontends (the schema domain today, UI next) build their pipeline on
// the same TS-AST helpers, use-site validator/formatter resolver, enum discovery, and the
// portable expression/statement/body lowering engine. None of this is schema-specific.
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

// Neutral class-decorator helpers (find a named `@Schema`/`@Edge`/`@Service` decorator,
// parse its object-literal options). Promoted from the schema domain so the base service
// pass — and any domain — shares one parser.
export { findKeymaClassDecorator, extractDecoratorOptions } from "./decorator.js";
export type { DecoratorOptions } from "./decorator.js";

export { discoverEnums } from "./discover-enums.js";
export type { EnumInfo } from "./discover-enums.js";

// The generic TS-type → IR-type mapper. Shared by the schema field extraction and the
// generic validator/method/function lowering, so it stays domain-neutral in the compiler.
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

export type {
    KeymaIR,
    IRClassDeclaration,
    IRMember,
    IRType,
    IRExpression,
    IRArrowParam,
    IRMethod,
    IRDefault,
    IRStatement,
    IRReturnStmt,
    IRIfStmt,
    IRConstDecl,
    IRExprStmt,
    IRAssignStmt,
    IRForOfStmt,
    IRWhileStmt,
    IRBreakStmt,
    IRContinueStmt,
    IRSwitchCase,
    IRSwitchStmt,
    IRFunctionParam,
    IRFunctionDeclaration,
    IRService,
    IRServiceMethod,
    IREnumDeclaration,
    IRDiagnostic,
    IRSourceLocation,
    TagManifest,
    TagManifestSchema,
} from "./types.js";

export { validateIR, IRValidatorRegistry, defaultIRValidators } from "./validate.js";
export type { IRValidationResult, IRValidationError, IRDocumentValidator } from "./validate.js";
// Domain-neutral IR-node validators + helpers, exported so domain packages (e.g.
// `@keyma/schema/ir`) can build their section checks on the same primitives and
// register them onto an IRValidatorRegistry. The envelope head/tail are the core
// defaults; the schema-section checks live in the schema domain.
export {
    checkEnvelopeHead,
    checkEnvelopeTail,
    checkServices,
    checkParam,
    checkType,
    checkTypeArgs,
    checkExpression,
    checkStatement,
    checkSourceLocation,
    checkDiagnostic,
    e,
    isObj,
    isStr,
    isNum,
    isBool,
    isArr,
} from "./validate.js";

// Shared IR builders — typed, valid-by-construction node constructors for the compiler
// and every domain frontend. `validateIR` remains the backstop.
export {
    external,
    typeVar,
    instanceType,
    fnType,
    arrayType,
    param,
    literal,
    field,
    ident,
    member,
    call,
    newExpr,
    obj,
    template,
    binary,
    unary,
    conditional,
    intrinsic,
    arrowExpr,
    arrowBlock,
    ret,
    constDecl,
    exprStmt,
    assign,
    ifStmt,
    method,
    funcDecl,
} from "./build.js";

export {
    INTRINSICS,
    intrinsicByOp,
    intrinsicByMember,
    IntrinsicRegistry,
    defaultIntrinsics,
} from "./intrinsics.js";
export type {
    IntrinsicDef,
    IntrinsicTier,
    IntrinsicReceiver,
    IntrinsicForm,
} from "./intrinsics.js";

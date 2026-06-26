export type {
    KeymaIR,
    IRSchema,
    IRField,
    IRType,
    IRValidator,
    IRFormatter,
    IRFormatterSpec,
    IRExpression,
    IRMethod,
    IRFormField,
    IRDefault,
    IRStatement,
    IRReturnStmt,
    IRIfStmt,
    IRConstDecl,
    IRExprStmt,
    IRAssignStmt,
    IRParam,
    IRFunctionBody,
    IRValidatorDeclaration,
    IRFormatterDeclaration,
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
    checkType,
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

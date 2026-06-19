export type {
    KeymaIR,
    IRSchema,
    IREdge,
    IRField,
    IRType,
    IRValidator,
    IRFormatter,
    IRFormatterSpec,
    IRFieldIndex,
    IRIndex,
    IRExpression,
    IRComputed,
    IRStatement,
    IRReturnStmt,
    IRIfStmt,
    IRConstDecl,
    IRExprStmt,
    IRParam,
    IRFunctionBody,
    IRValidatorDeclaration,
    IRFormatterDeclaration,
    IRFunctionParam,
    IRFunctionDeclaration,
    IRDiagnostic,
    IRSourceLocation,
} from "./types.js";

export { validateIR } from "./validate.js";
export type { IRValidationResult, IRValidationError } from "./validate.js";

export {
    INTRINSICS,
    intrinsicByOp,
    intrinsicByMember,
} from "./intrinsics.js";
export type {
    IntrinsicDef,
    IntrinsicTier,
    IntrinsicReceiver,
    IntrinsicForm,
} from "./intrinsics.js";

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
} from "./types.js";

export { validateIR } from "./validate.js";
export type { IRValidationResult, IRValidationError } from "./validate.js";

export { collectFieldRefs } from "./expr-deps.js";

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

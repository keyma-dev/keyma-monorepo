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
    IRDiagnostic,
    IRSourceLocation,
} from "./types.js";

export { validateIR } from "./validate.js";
export type { IRValidationResult, IRValidationError } from "./validate.js";

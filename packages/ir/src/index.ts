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
    IRDiagnostic,
    IRSourceLocation,
} from "./types.js";

export { validateIR } from "./validate.js";
export type { IRValidationResult, IRValidationError } from "./validate.js";

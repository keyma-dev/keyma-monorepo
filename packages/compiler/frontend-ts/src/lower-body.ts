/**
 * Validator/formatter/utility-function bodies are lowered with the shared portable
 * expression engine in `lower-portable-expr.ts` (params mode). This module re-exports
 * the body-facing surface so existing callers keep importing from `./lower-body.js`.
 */
export { lowerExpr, lowerStatement, lowerBlock } from "./lower-portable-expr.js";
export type { BodyLowerCtx, FnRefVerdict } from "./lower-portable-expr.js";

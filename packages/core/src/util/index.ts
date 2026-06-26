// Browser-safe helpers shared by Keyma compiler frontends and backends. Runtime-dependency-free:
// the sole dependency, ../../ir/src/index.js, is imported for types only and emits no runtime code.

// POSIX path utilities. Consumers use the `path` namespace object (mirrors `node:path`'s shape)
// in place of `import path from "node:path"` — e.g. `path.join`, `path.posix.relative`.
export { default as path } from "./path.js";

// Source-file → output-module-path helpers shared across the language backends.
export * from "./module-path.js";

// Language-neutral IR traversal, visibility filtering, and code-emission helpers.
export * from "./ir-walk.js";
export * from "./visibility.js";
export * from "./inheritance.js";
export * from "./emit-literal.js";
export * from "./diagnostics.js";

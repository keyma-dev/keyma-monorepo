// Browser-safe, dependency-free helpers shared by Keyma compiler frontends and backends.

// POSIX path utilities. Consumers use the `path` namespace object (mirrors `node:path`'s
// shape) in place of `import path from "node:path"`; individual functions are also exported.
export { default as path } from "./path.js";
export * from "./path.js";

// Source-file → output-module-path helpers shared across the language backends.
export * from "./module-path.js";

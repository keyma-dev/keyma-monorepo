import type { Kysely } from "kysely";
import type { SchemaMetadata } from "@keyma/runtime/schema";

/** Runtime-driven schemas: we don't know table names at compile time, so the
 *  internal Kysely instance is typed permissively. The public adapter API
 *  remains the dialect-neutral `KeymaDatabaseAdapter`. */
export type AnyDb = Kysely<Record<string, Record<string, unknown>>>;

export type SchemaMap = ReadonlyMap<string, SchemaMetadata>;

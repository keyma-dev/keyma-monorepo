import type { SchemaMetadata, SchemaClass, ServiceMetadata, ServiceClass } from "./types.js";

// Runtime helpers that attach the generated metadata statics (`schema` / `service`)
// to a plain class. Kept out of `types.ts` so that file stays pure type
// declarations — the JS backend inlines a verbatim copy of it as a dependency-free
// `types.d.ts` in every generated bundle.

/** Brand a plain class with SchemaMetadata at runtime (tests / codegen fallback). */
export function brandSchema<T>(
    cls: new (value?: Partial<T>) => T,
    schema: SchemaMetadata,
): SchemaClass<T> {
    Object.defineProperty(cls, "schema", {
        value: schema,
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return cls as SchemaClass<T>;
}

/** Brand a plain class with ServiceMetadata at runtime (tests / codegen fallback). */
export function brandService<C extends Function>(
    cls: C,
    service: ServiceMetadata,
): C & ServiceClass {
    Object.defineProperty(cls, "service", {
        value: service,
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return cls as C & ServiceClass;
}

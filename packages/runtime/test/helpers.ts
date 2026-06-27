// Shared test scaffolding — builds an EMITTED-shape model class from codec metadata: a class
// carrying its `ClassMeta` under a static `metadata` and hydrating via a static `fromValue`
// factory (`Object.create` + field copy), exactly as the compiler emits. The codec keys off this
// shape (`type.target` / `cls.metadata` / `cls.fromValue`), so these stand in for generated code.

import type { ClassMeta, ClassRef } from "../src/fields.js";

export function defineClass(metadata: ClassMeta): ClassRef {
    const Cls = class {
        static metadata = metadata;
        static fromValue(value: unknown): unknown {
            const instance = Object.create(this.prototype) as Record<string, unknown>;
            if (value) Object.assign(instance, value as Record<string, unknown>);
            return instance;
        }
    };
    return Cls as unknown as ClassRef;
}

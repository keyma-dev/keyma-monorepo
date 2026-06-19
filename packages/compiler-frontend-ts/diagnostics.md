# @keyma/compiler-frontend-ts — Diagnostic Codes

Every error produced by this package carries a stable `KEYMA####` code. Codes are never renumbered.

## Schema-level structural errors (0001–0009)

### KEYMA001 — Duplicate schema name

Two `@Schema`-decorated classes resolve to the same database name.

```typescript
@Schema({ name: "user" }) class UserA {}
@Schema({ name: "user" }) class UserB {} // KEYMA001
```

### KEYMA002 — Schema missing name

*Reserved. Not yet emitted by this version.*

---

## Field-level errors (0010–0019)

### KEYMA010 — Unknown field type

A field's TypeScript type cannot be mapped to an IR type.

```typescript
@Schema() class Foo {
    declare bar: SomeUnknownType; // KEYMA010
}
```

### KEYMA011 — Non-literal decorator argument

A decorator argument that requires a literal value (string, number, boolean, array, or object literal) received something else.

```typescript
const n = 2;
@Validate(minLength(n)) // KEYMA011 — n is not a literal
declare name: string;
```

### KEYMA012 — Validator/formatter incompatible with field type

*Reserved. Not yet emitted by this version.*

### KEYMA013 — Missing required option

A parameterized marker call is missing its required argument.

```typescript
@Validate(minLength()) // KEYMA013 — value argument required
declare name: string;
```

### KEYMA014 — Unsupported computed getter expression

A `get` accessor body contains an expression that cannot be lowered to `IRExpression`.

```typescript
get name() { return someExternalFunction(); } // KEYMA014
```

### KEYMA015 — Computed getter must have no setter

A `get` accessor that would be treated as a computed field also has a `set` accessor.

```typescript
get name() { return this._name; }
set name(v: string) { this._name = v; } // KEYMA015
```

---

## Validator / formatter errors (0020–0029)

### KEYMA020 — Unknown validator

An identifier passed to `@Validate()` is not a known built-in validator and is not a call expression.

```typescript
@Validate(someRandomValue) // KEYMA020
declare field: string;
```

### KEYMA021 — Unknown formatter

An identifier passed to `@Format()` is not a known built-in formatter.

### KEYMA022 — Unknown custom validator (not registered)

`customValidator("myCheck")` is used but `"myCheck"` was not listed in `customValidators` config.

### KEYMA023 — Unknown custom formatter (not registered)

`customFormatter("myFmt")` is used but `"myFmt"` was not listed in `customFormatters` config.

### KEYMA024 — Empty enum values list

A string literal union type has no members.

---

## Visibility and inheritance errors (0030–0039)

### KEYMA031 — Public schema leaks private schema

A public schema has a non-private field whose type references a private schema.

```typescript
@Schema({ private: true }) class Secret { ... }
@Schema() class Public {
    declare secret: Secret; // KEYMA031
}
```

### KEYMA032 — Public schema extends private parent

A public schema extends a private schema, which would expose private fields.

```typescript
@Schema({ private: true }) class Base { ... }
@Schema() class Child extends Base { ... } // KEYMA032
```

### KEYMA033 — Child extends a non-@Schema class

A schema's `extends` clause names a class that is not decorated with `@Schema`.

```typescript
class PlainBase {}
@Schema() class Child extends PlainBase { ... } // KEYMA033
```

### KEYMA034 — Incompatible type override

A child schema's field overrides a parent field with a different, incompatible type.

### KEYMA035 — Persisted schema references an ephemeral schema

A persisted (non-ephemeral) schema holds a `Reference<T>` to an ephemeral schema. Ephemeral schemas (`@Schema({ ephemeral: true })`) are never stored, so they cannot be a reference (foreign-key) target. `Embedded<T>` of an ephemeral schema is allowed, since the data is inlined rather than referenced.

```typescript
@Schema({ ephemeral: true }) class Token { declare id: ID; }
@Schema() class Session {
    declare token: Reference<Token>; // KEYMA035
}
```

### KEYMA036 — Indexes on an ephemeral schema (warning)

An ephemeral schema declares field or composite indexes. Indexes only affect persisted data, so they have no effect on an ephemeral schema.

```typescript
@Schema({ ephemeral: true }) class Payload {
    @Indexed() declare key: string; // KEYMA036 (warning)
}
```

---

## Naming and duplication errors (0040–0049)

### KEYMA040 — Duplicate field name

A class declares the same field name twice.

```typescript
@Schema() class Foo {
    declare name: string;
    declare name: number; // KEYMA040
}
```

---

## Generics and unsupported language features (0050–0059)

### KEYMA050 — Unsupported generic type parameter

A type reference uses a generic parameter that is not a supported DSL wrapper (`Nullable<T>`, `Reference<T>`, `Embedded<T>`, `Array<T>`).

---

## Edge schema errors (0060–0069)

### KEYMA060 — @Edge from/to points at an edge schema

A `@From()`/`@To()` endpoint field's node type is itself an edge schema. Endpoints must be node schemas.

```typescript
@Edge() class Knows { @From() from!: User; @To() to!: User; }
@Edge() class Meta {
    @From() from!: Knows; // KEYMA060 — Knows is an edge, not a node
    @To() to!: User;
}
```

### KEYMA061 — Edge endpoint field is not a node reference

A `@From()`/`@To()` field is typed as something other than a node reference (a `@Schema` class, or `Reference<T>`).

```typescript
@Edge()
class Knows {
    @From() from!: string;       // KEYMA061 — not a node reference
    @To() to!: User;
}
```

### KEYMA062 — (obsolete)

Previously "Edge from/to field not indexed". `@From()`/`@To()` fields are now indexed automatically, so this is never emitted. The code is retained and not reused.

### KEYMA063 — (obsolete)

Previously "@Edge from/to argument is not a class identifier". `from`/`to` are no longer options — endpoints come from `@From()`/`@To()` fields — so this is never emitted. The code is retained and not reused.

### KEYMA064 — Edge schema used as a node reference

A non-edge schema has a `Reference<EdgeClass>` or `Embedded<EdgeClass>` field. Edges are not addressable as nodes; if you want to expose edges, query them with `Keyma.list(EdgeClass, ...)` or via traversal.

```typescript
@Edge() class Knows { @From() from!: User; @To() to!: User; }
@Schema() class Thing {
    rel!: Reference<Knows>; // KEYMA064
}
```

### KEYMA065 — Edge schema missing @From() or @To()

An `@Edge` class must declare exactly one `@From()` field and one `@To()` field.

```typescript
@Edge()
class Knows {
    @From() from!: User; // KEYMA065 — no @To() field
}
```

### KEYMA066 — Edge schema has duplicate @From() or @To()

An `@Edge` class declares more than one `@From()` or more than one `@To()` field. Exactly one of each is allowed.

```typescript
@Edge()
class Knows {
    @From() a!: User;
    @From() b!: User; // KEYMA066 — two @From() fields
    @To() to!: User;
}
```

---

## Reference errors (0070–0079)

### KEYMA070 — Reference target has no ID field

A `Reference<T>` field's target schema does not declare a field of type `ID`. References are stored as foreign keys to the target's identifier, so the target must expose an `id: ID` field (typically `@Indexed({ unique: true }) declare readonly id: ID;`).

```typescript
@Schema() class Tag {
    declare label: string; // no `id: ID`
}
@Schema() class Post {
    declare tag: Reference<Tag>; // KEYMA070
}
```

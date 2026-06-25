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

### KEYMA014 — Unsupported getter accessor body

A getter body contains a statement or expression that cannot be lowered to portable IR, or
never reaches a `return`. A getter is a behavior (a re-emitted class accessor); its body lowers
the full portable **statement** subset (`const`/`if`/`return`) through the same engine as
validator/formatter bodies, so intrinsics, `typeof`, conditionals, templates, `new`, local
`const` bindings, and arrow params are allowed; arbitrary function/method calls and array
literals are not, and the body must reach a `return` statement (assignment is not allowed — a
getter reads, it does not mutate). Bare names bound by a local `const`/arrow param resolve to
that local, not a schema field.

```typescript
get name(): string { return someExternalFunction(); }          // KEYMA014 — non-portable call
get size(): number { const n = this.items.length; }            // KEYMA014 — no return statement
get scaled(): number { const x = this.n; return x * 2; }       // OK — multi-statement, x is a local
```

### KEYMA015 — (obsolete) Computed getter must have no setter

**No longer emitted.** A getter may be paired with a `set` accessor of the same name (an accessor
get/set pair); both are emitted as behaviors. The code is retained but unused.

```typescript
get name(): string { return this.firstName; }
set name(value: string) { this.firstName = value; } // OK — getter + setter accessor pair
```

### KEYMA018 — (obsolete) Computed getter dependency cycle

**No longer emitted.** Getters are now plain accessors (computed *fields* — storage, indexing,
materialization — are deferred to a future release; see KEYMA098), so there is no materialization
order to cycle-check. The code is retained but unused.

### KEYMA019 — @Computed applied to a non-getter

`@Computed()` only belongs on a getter (where it is currently a deferred-feature marker — see
KEYMA098). Applying it to a plain property is an error.

```typescript
@Computed() declare first: string;          // KEYMA019 (error) — not a getter
```

---

## Validator / formatter errors (0020–0029)

### KEYMA020 — Not a validator factory

The argument to `@Validate()` does not resolve to a validator factory — a function returning `ValidatorFn` (e.g. `minLength(2)`).

```typescript
@Validate(someRandomValue) // KEYMA020
declare field: string;
```

### KEYMA021 — Not a formatter factory

The argument to `@Format()` does not resolve to a formatter factory — a function returning `FormatterFn` (e.g. `trim()`).

### KEYMA022 — Unknown custom validator (not registered)

`customValidator("myCheck")` is used but `"myCheck"` was not listed in `customValidators` config.

### KEYMA023 — Unknown custom formatter (not registered)

`customFormatter("myFmt")` is used but `"myFmt"` was not listed in `customFormatters` config.

### KEYMA024 — Empty enum values list

A string literal union type has no members.

### KEYMA025 — Unsupported enum member

A field references a TypeScript `enum`, but the enum is not portable: a member is missing a
string initializer (numeric, computed, or heterogeneous). Named enums must be string enums.

```typescript
enum Level { Low, High }                 // numeric — not portable
@Schema() class Foo { declare level: Level; } // KEYMA025
enum Status { Active = "active" }        // OK — string enum
```

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

A child schema's field override is not a subtype of the parent field. Safe narrowing is allowed
(`number` ⊇ `integer`, an enum value-set subset, dropping `| null`); widening is rejected
(adding `| null`, an enum superset, an unrelated type).

```typescript
@Schema() class Base { declare x: number; declare y: string; }
@Schema() class Child extends Base {
    declare x: string;          // KEYMA034 — unrelated type
    declare y: string | null;   // KEYMA034 — widens with null
}
```

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

### KEYMA037 — Public schema has only private fields

A public schema whose every field is `private` has no public surface. It would emit into the
client bundle with nothing readable, while on the server a default (unprojected) read collapses
to an empty projection — which adapters treat as "return the whole record", leaking the private
data the schema meant to hide. Mark the schema `@Schema({ private: true })` (so only the in-process
system identity can reach it) or make at least one field public. Any field kind — stored, computed,
reference, or embedded — counts as public surface. Fieldless schemas are exempt.

```typescript
@Schema() class Token {                  // KEYMA037 — public, but no public field
    private declare value: string;
    private declare refreshedAt: string;
}

@Schema({ private: true }) class Token { // OK — private schema, system-only
    private declare value: string;
}

@Schema() class User {                   // OK — `id`/`name` are public surface
    declare id: ID;
    declare name: string;
    private declare passwordHash: string;
}
```

---

## Naming and duplication errors (0040–0049)

### KEYMA040 — Duplicate member name

A class declares the same member name twice. This covers duplicate fields, duplicate
method/setter names, and a method whose name collides with a field. A **setter** may
share a name with a field (a stored field, or a `@Computed` getter forming a get/set
pair) — that is allowed.

```typescript
@Schema() class Foo {
    declare name: string;
    declare name: number;        // KEYMA040 — duplicate field
    greeting(): string { return this.name; }
    greeting(p: string): string { return p; } // KEYMA040 — duplicate method
    name(): string { return ""; }             // KEYMA040 — method collides with field
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

### KEYMA071 — Bare @Schema class field

A field is typed as a bare `@Schema` class. Relationship intent must be explicit: use
`Reference<T>` (a foreign key storing the target's id) or `Embedded<T>` (an inline copy).

```typescript
@Schema() class Post {
    declare author: User;              // KEYMA071
    declare author2: Reference<User>;  // OK — foreign key
    declare meta: Embedded<Meta>;      // OK — inline copy
}
```

### KEYMA072 — Embedded type cycle

`Embedded<T>` inlines a copy of the target. A cycle of embeds — including the degenerate
self-embed — describes infinitely-nested data and can never be materialized, so it is rejected.
Only embedded edges count (also through `Embedded<T>[]`); `Reference<T>` stores just an id, so a
reference cycle is legal. Break the cycle by replacing an `Embedded<T>` with `Reference<T>`.

```typescript
@Schema() class Node {
    declare child: Embedded<Node>;     // KEYMA072 — self-embed
}
@Schema() class A { declare b: Embedded<B>; }   // KEYMA072 — A → B → A
@Schema() class B { declare a: Embedded<A>; }
@Schema() class C { declare a: Reference<A>; }   // OK — foreign key, no inlining
```

---

## Validator / formatter / utility-function compilation errors (0080–0089)

These fire when a `Validator("name", fn)` / `Formatter("name", fn)` declaration (or a
utility function it references) is lowered to portable IR.

### KEYMA080 — _(retired)_

Was: `Validator()`/`Formatter()` must be assigned to an exported const. Obsolete since validators/
formatters are now plain factory functions returning `ValidatorFn`/`FormatterFn` (no markers). The
code is retained but no longer emitted.

### KEYMA081 — factory does not return an inner function

The factory must return an inner `(value[, field[, context]]) => …` function (directly, or
via a single `return`).

```typescript
export function minLen(n: number): ValidatorFn<string> {
    return (value, field) => value.length >= n ? null : { field, code: "MIN", message: "…" };
}
```

### KEYMA082 — unsupported statement/expression in body

The body uses a construct outside the portable subset (loops, unsupported operators, shorthand
object properties, etc.).

### KEYMA083 — inner function has wrong arity

The inner function must take 1–3 parameters: `value`, optional `field`, optional `context`.

### KEYMA084 — _(retired)_

Was: the inner `value` parameter must declare a concrete type. The input type now comes from the
factory's `ValidatorFn<T>`/`FormatterFn<T>` return annotation (`<T>` is the guard type; absent ≡
`json`/no guard). The code is retained but no longer emitted.

### KEYMA085 — unsupported string/array intrinsic

A method or property used on a `string`/array receiver (in a validator/formatter/getter body)
is not in the intrinsic registry (see `packages/ir/intrinsics.md`), or its receiver type could
not be resolved.

### KEYMA086 — utility function cannot be compiled

A function called from a body could not be compiled: it is not project-local (lives in
`node_modules` or a `.d.ts`), has an untyped parameter/return, or collides on name with
another utility function.

### KEYMA087 — non-portable `instanceof`

The right-hand side of `instanceof` (in a validator/formatter/getter body) is outside the
portable constructor set (`Date`, `RegExp`, `Uint8Array`, `Array`).

---

## Default value & behavior errors (0090–0099)

### KEYMA090 — default value incompatible with field type

A field's literal property initializer does not match the field's type (e.g. a number default
on a string field).

```typescript
status: string = 5; // KEYMA090
```

### KEYMA091 — obsolete

Defaults are now authored as native TypeScript property initializers rather than a `@Default`
decorator, so there is no longer an "unsupported `@Default` form" to report. A literal
initializer is checked by KEYMA090; a non-literal initializer (`= (() => new Date())()`,
`= myFn()`) is lowered through the portable expression engine and any unsupported construct
self-reports via the portable-subset codes (KEYMA082/085/086/087). The code is retained (never
renumbered) but no longer emitted.

### KEYMA092 — method/setter signature must be explicitly typed

A method or setter parameter has no type annotation, or a method has no return type. Because
behavior bodies are lowered to the portable IR and re-emitted in every target, their
signatures must be explicit and concrete. Use `: void` for a method that returns nothing.

```typescript
@Schema() class Foo {
    declare x: string;
    bad(p): string { return p; }        // KEYMA092 — parameter `p` is untyped
    alsoBad() { return this.x; }         // KEYMA092 — missing return type
    good(p: string): string { return p; } // OK
    touch(): void { this.x = "y"; }       // OK — explicit void
}
```

> Async and generator methods are not portable; they are rejected with **KEYMA082**.

---

## Deferred-feature warnings

### KEYMA098 — computed-field decorator on a getter is ignored (warning)

A getter carries `@Computed()` and/or `@Indexed()` (or another field-only decorator such as
`@FormField`/`@Deprecated`). Getters are emitted as plain class accessors (behaviors), but
treating one as a **stored / indexed / materialized field** is deferred to a future release, so
those decorators are ignored — the getter is still emitted as an accessor. Remove the decorators
to silence the warning.

```typescript
@Indexed() @Computed() get fullName(): string { // KEYMA098 (warning) — emitted as a plain accessor
    return `${this.first} ${this.last}`;
}
```

---

## Service (remote function call) errors (0093–0099)

`@Service`-decorated abstract classes declare remotely-callable methods. Only the
method *signatures* are lowered to IR — implementations live in server runtime code,
supplied by extending the generated abstract class. Service method signatures must be
explicitly typed (reuses **KEYMA092**) and their parameter/return types must be
mappable (reuses **KEYMA010**). Service methods may be `async`/`Promise<T>` (the
`Promise<...>` wrapper is peeled) — they are *not* lowered like portable behaviors, so
**KEYMA082** does not apply.

### KEYMA093 — service method must be abstract

A method on a `@Service` class has a body. Service methods are contracts; implement
them in server code by extending the generated class.

```typescript
@Service() abstract class UserService {
    abstract sendInvite(input: InviteInput): InviteResult;  // OK
    greet(): string { return "hi"; }                         // KEYMA093 — has a body
}
```

### KEYMA094 — duplicate method name within a service

Two methods on the same `@Service` class share a name.

### KEYMA095 — @Service combined with @Schema/@Edge

A class carries `@Service` together with `@Schema` or `@Edge`. A service declares
callable methods, not a data model — keep them on separate classes.

### KEYMA096 — public service exposes a private schema

A public method on a public service has a parameter or return type that references a
`@Schema({ private: true })` schema, which would leak it into the client bundle. Make
the schema public, or the service/method private.

### KEYMA097 — duplicate service name / collides with a schema

Two services resolve to the same name, or a service name collides with a schema name.
Service names double as generated class names and must be unique across the program.

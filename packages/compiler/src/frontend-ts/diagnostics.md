# @keyma/compiler/frontend-ts — Diagnostic Codes

Every error this package produces carries a stable `KEYMA####` code. Codes are never renumbered.
This list covers only the **compiler-owned** codes — the generic type-mapping, portable-body
lowering, control-flow, and `@Service` base pass. A domain's own diagnostic codes (its class
discovery, relationships, and authoring-decorator checks) live in that domain's
`frontend-ts/diagnostics.ts`.

## Field type mapping

### KEYMA010 — Unknown field type

A TypeScript type cannot be mapped to an IR type.

```typescript
declare bar: SomeUnknownType; // KEYMA010
```

### KEYMA050 — Unsupported generic type parameter

A type reference uses a generic parameter that is not a supported DSL wrapper (`Nullable<T>`,
`Reference<T>`, `Embedded<T>`, `Array<T>`).

### KEYMA071 — Bare model-class field

A field is typed as a bare model class. Relationship intent must be explicit: use `Reference<T>`
(a foreign key storing the target's id) or `Embedded<T>` (an inline copy). `Reference`/`Embedded`
are `@keyma/core/dsl` types.

```typescript
declare author: User;              // KEYMA071
declare author2: Reference<User>;  // OK — foreign key
declare meta: Embedded<Meta>;      // OK — inline copy
```

## Enum mapping

### KEYMA024 — Empty enum values list

A string-literal union type has no members.

### KEYMA025 — Unsupported enum member

A field references a TypeScript `enum`, but the enum is not portable: a member is missing a
string initializer (numeric, computed, or heterogeneous). Named enums must be string enums.

```typescript
enum Level { Low, High }      // numeric — not portable        // KEYMA025 where referenced
enum Status { Active = "active" }  // OK — string enum
```

### KEYMA099 — Invalid numeric width

A width-templated numeric type was given a bit width outside its allowed set:
`Integer<Bits>`/`Unsigned<Bits>` accept `8 | 16 | 32 | 64`, and `Float<Bits>` accepts `32 | 64`.
The width argument must be a numeric literal in that set.

```ts
declare count: Unsigned<7>;   // KEYMA099 — 7 is not 8|16|32|64
declare ratio: Float<16>;     // KEYMA099 — 16 is not 32|64
declare ok: Integer<32>;      // fine
```

## Getter / portable function body lowering

These fire when a getter, method, setter, or project-local function body is lowered to portable IR.

### KEYMA014 — Unsupported getter accessor body

A getter body contains a statement or expression that cannot be lowered to portable IR, or never
reaches a `return`. A getter is a behavior (a re-emitted class accessor); its body lowers the full
portable **statement** subset (`const`/`if`/`return`) through the same engine as other portable
bodies, so intrinsics, `typeof`, conditionals, templates, `new`, local `const` bindings, and arrow
params are allowed; arbitrary function/method calls and array literals are not, and the body must
reach a `return` statement (assignment is not allowed — a getter reads, it does not mutate). Bare
names bound by a local `const`/arrow param resolve to that local, not a class field.

```typescript
get name(): string { return someExternalFunction(); }    // KEYMA014 — non-portable call
get size(): number { const n = this.items.length; }       // KEYMA014 — no return statement
get scaled(): number { const x = this.n; return x * 2; }   // OK — multi-statement, x is a local
```

### KEYMA082 — Unsupported statement/expression in a portable body

A portable body uses a construct outside the portable subset (unsupported operators, shorthand
object properties, etc.). Async and generator methods are also rejected here.

### KEYMA085 — Unsupported string/array intrinsic

A method or property used on a `string`/array/regexp/date receiver is not in the intrinsic
registry (see `packages/ir/intrinsics.md`), or its receiver type could not be resolved.

### KEYMA086 — Utility function cannot be compiled

A function called from a body could not be compiled: it is not project-local (lives in
`node_modules` or a `.d.ts`), has an untyped parameter/return, or collides on name with another
utility function.

### KEYMA087 — Non-portable `instanceof`

The right-hand side of `instanceof` is outside the portable constructor set (`Date`, `RegExp`,
`Uint8Array`, `Array`).

## Method / setter behavior

### KEYMA092 — Method/setter signature must be explicitly typed

A method or setter parameter has no type annotation, or a method has no return type. Because
behavior bodies are lowered to portable IR and re-emitted in every target, their signatures must
be explicit and concrete. Use `: void` for a method that returns nothing.

```typescript
bad(p): string { return p; }        // KEYMA092 — parameter `p` is untyped
alsoBad() { return this.x; }         // KEYMA092 — missing return type
good(p: string): string { return p; } // OK
touch(): void { this.x = "y"; }       // OK — explicit void
```

## Control-flow lowering (KEYMA0201–0207)

Loops, constructors, and destructors lowered to the portable subset.

- **KEYMA0201** — C-style `for (init; cond; update)` desugared to a `while` loop (warning).
- **KEYMA0202** — `continue` inside a C-style `for` is not portable (the while-desugar cannot run
  the update step before continuing).
- **KEYMA0203** — `for…in` is not portable — iterate `Object.keys`/`Object.entries` with `for…of`.
- **KEYMA0204** — unsupported loop binding (`for…of`/C-style-`for` need a single `const`/simple
  identifier binding — no `let`/`var`/destructuring).
- **KEYMA0205** — labeled `break`/`continue` is not portable.
- **KEYMA0206** — a destructor must be a no-parameter, void-returning, synchronous method.
- **KEYMA0207** — a constructor may not be async.

## Service (remote function call) errors

`@Service`-decorated abstract classes declare remotely-callable methods. Only the method
*signatures* are lowered to IR — implementations live in server runtime code, supplied by
extending the generated abstract class. Service method signatures must be explicitly typed
(reuses **KEYMA092**) and their parameter/return types must be mappable (reuses **KEYMA010**).
Service methods may be `async`/`Promise<T>` (the `Promise<...>` wrapper is peeled) — they are
*not* lowered like portable behaviors, so **KEYMA082** does not apply.

### KEYMA093 — Service method must be abstract

A method on a `@Service` class has a body. Service methods are contracts; implement them in server
code by extending the generated class.

```typescript
@Service() abstract class UserService {
    abstract sendInvite(input: InviteInput): InviteResult;  // OK
    greet(): string { return "hi"; }                         // KEYMA093 — has a body
}
```

### KEYMA094 — Duplicate method name within a service

Two methods on the same `@Service` class share a name.

### KEYMA095 — A class is both a service and a data model

A `@Service` class is also produced as a data model (the same authored class is a contributed
model class of any data-producing domain). A service declares callable methods, not stored fields
— split the callable contract from the data class. The check is domain-agnostic: it flags a
`@Service` whose authored name also appears among the classes the frontend domains produced.

### KEYMA096 — Public service exposes a private model class

A public method on a public service has a parameter or return type that references a private model
class, which would leak it into the client bundle. Make the model class public, or the
service/method private.

### KEYMA097 — Duplicate service name / collides with a model-class name

Two services resolve to the same name, or a service name collides with a model-class name. Service
names double as generated class names and must be unique across the program.

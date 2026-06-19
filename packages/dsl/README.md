# @keyma/dsl

Type-only declarations for the Keyma authoring DSL. Provides decorators, validator markers, formatter markers, and semantic types with full TypeScript/IntelliSense support. No runtime reflection, no `tslib`, no `reflect-metadata`.

## Purpose

This package is what developers import when writing Keyma schemas. It:

- Type-checks cleanly in any TypeScript editor
- Provides no-op runtime implementations so schemas can be imported in test/editor environments
- Requires no runtime emit (`experimentalDecorators` only, no `emitDecoratorMetadata`)
- Has zero production dependencies

## Public API

### Decorators

```typescript
import {
    Schema, Validate, Indexed, Format, Phase,
    Computed, Default, Now, FormField, Edge, From, To,
} from "@keyma/dsl";
import type { ID, DateTime, Reference } from "@keyma/dsl";
import { isEmail, minLength, maxLength } from "@keyma/validators";
import { trim, normalizeEmail } from "@keyma/formatters";

// A named, reusable string enum — author once, reference anywhere.
enum Role { Admin = "admin", Member = "member", Guest = "guest" }

@Schema({ name: "user" })
class User {
    @Indexed({ unique: true })
    declare readonly id: ID;

    @Validate(isEmail(), maxLength(255))
    @Format(Phase.Save, normalizeEmail())
    @Indexed({ unique: true })
    @FormField({ title: "Email address", hint: "We never share it." })
    declare email: string;

    @Validate(minLength(2), maxLength(64))
    @Format(Phase.Change, trim())
    declare firstName: string;

    declare lastName: string;

    @Default(Role.Member)
    declare role: Role;

    @Default(Now)
    declare createdOn: DateTime;

    // Computed fields are explicit and use the portable expression subset.
    @Computed() get displayName(): string {
        return `${this.firstName} ${this.lastName}`;
    }

    // Methods are portable behaviors emitted onto the generated model class.
    greeting(prefix: string): string {
        return `${prefix} ${this.firstName.toUpperCase()}`;
    }

    // A setter is a "virtual" writable property that distributes the written
    // value back into stored fields. (Pairs with the `displayName` getter above.)
    set displayName(value: string) {
        this.firstName = value;
    }
}

// Relationships are explicit: Reference<T> (foreign key) or Embedded<T> (inline).
@Edge()
class Follows {
    declare readonly id: ID;
    @From() declare from: Reference<User>;
    @To() declare to: Reference<User>;
}
```

Key authoring rules:

- **Relationships are explicit.** A bare `@Schema` class field is rejected (`KEYMA071`) —
  use `Reference<T>` (stores the target's id) or `Embedded<T>` (inlines a copy).
- **Computed fields are explicit.** Only getters decorated with `@Computed()` become fields.
- **Methods and setters are portable behaviors.** Plain instance methods and `set` accessors
  are emitted onto the generated model class in every target. They are not stored fields;
  their bodies use the portable subset (plus `this.field = …` assignment). See
  "Methods and setters" below.
- **Optional vs. nullable are orthogonal.** `field?: T` means the key may be *absent*;
  `Nullable<T>` (or `T | null`) means the value may be *null*. They compose freely.
- **`@Default`** fills a value on create when the key is absent — a literal or a named
  generator (`Now`, `Uuid`).
- **`@Format(Phase.…, …)`** — `Phase` constants (`Change`/`Blur`/`Submit`/`Save`) replace
  bare string literals.
- **Named enums** are authored as TypeScript string `enum`s and reused across schemas.

### Semantic types

| Type | IR mapping | Description |
|---|---|---|
| `ID` | `{ kind: "id" }` | Opaque database identifier |
| `DateOnly` | `{ kind: "date" }` | Calendar date (YYYY-MM-DD) |
| `DateTime` | `{ kind: "dateTime" }` | Instant with timezone (ISO 8601) |
| `TimeOfDay` | `{ kind: "time" }` | Time of day (HH:MM:SS) |
| `Decimal` | `{ kind: "decimal" }` | Arbitrary-precision decimal |
| `Json` | `{ kind: "json" }` | Arbitrary JSON value |
| `Bytes` | `{ kind: "bytes" }` | Binary blob |
| `Nullable<T>` | field flag `nullable: true` | Value may be `null` (orthogonal to optionality) |
| `Reference<T>` | `{ kind: "reference", schema, idType }` | Foreign reference (stores the target's id) |
| `Embedded<T>` | `{ kind: "embedded", schema }` | Inline sub-document |

> `Nullable<T>` is no longer a type wrapper in the IR — nullability is a field-level boolean,
> so a value may be both optional (`?`) and nullable. Bare `@Schema` class fields are rejected;
> always write `Reference<T>` or `Embedded<T>`.

### Validators

All validator markers are passed to `@Validate(...)`:

| Marker | IR kind |
|---|---|
| `isRequired` | `required` |
| `minLength(n)` | `minLength` |
| `maxLength(n)` | `maxLength` |
| `length(n)` | `length` |
| `min(n)` | `min` |
| `max(n)` | `max` |
| `multipleOf(n)` | `multipleOf` |
| `isPositive` | `positive` |
| `isNonNegative` | `nonNegative` |
| `isNegative` | `negative` |
| `isNonPositive` | `nonPositive` |
| `isInteger` | `integer` |
| `minDate(iso)` | `minDate` |
| `maxDate(iso)` | `maxDate` |
| `minItems(n)` | `minItems` |
| `maxItems(n)` | `maxItems` |
| `uniqueItems` | `uniqueItems` |
| `pattern(re)` | `pattern` |
| `isEmailAddress` | `emailAddress` |
| `isUrl(opts?)` | `url` |
| `isUuid` | `pattern` (UUID regex) |
| `isPhoneNumber(opts?)` | `phoneNumber` |
| `isIpAddress(opts?)` | `ipAddress` |
| `oneOf(values)` | `oneOf` |
| `customValidator(name)` | `custom` |

### Formatters

All formatter markers are passed to `@Format(phase, ...)`:

| Marker | IR kind |
|---|---|
| `trim` | `trim` |
| `normalizeWhitespace` | `normalizeWhitespace` |
| `lowercase` | `lowercase` |
| `uppercase` | `uppercase` |
| `titleCase` | `titleCase` |
| `capitalize` | `capitalize` |
| `stripNonDigits` | `stripNonDigits` |
| `normalizeEmail` | `normalizeEmail` |
| `normalizePhone(opts?)` | `normalizePhone` |
| `normalizeUrl` | `normalizeUrl` |
| `slugify` | `slugify` |
| `truncate(maxLength)` | `truncate` |
| `customFormatter(name)` | `custom` |

### Custom validators & formatters

Declare custom validators/formatters with the `Validator`/`Formatter` factories. The name can
be inferred from the exported `const` binding, or given explicitly when it must differ:

```typescript
import { Validator, Formatter } from "@keyma/dsl";

// Name inferred from the binding → registered as "minLen".
export const minLen = Validator((n: number) => (value: string) =>
    value.length >= n ? null : { field: "", code: "MIN_LEN", message: `min ${n}` });

// Explicit name (binding and registered name differ).
export const isEmail = Validator("emailAddress", () => (value: string) =>
    value.includes("@") ? null : { field: "", code: "EMAIL", message: "invalid" });
```

### Portable expression subset

The bodies of **validators, formatters, `@Computed()` getters, methods, and setters** are read
by the compiler and re-emitted in every target language, so they are restricted to a portable
subset:

- **Statements:** `return`, `if`/`else`, single-binding `const`, expression statements, and
  (methods/setters only) `this.field = …` assignment. No loops, `switch`, `try`/`catch`,
  `throw`, `await`, or spread.
- **Expressions:** literals, field/parameter references, member access, template strings,
  the standard binary/unary/ternary operators, object literals, regex literals, and `new`.
- **Method/property calls** are limited to the **intrinsic registry** (e.g. `.includes()`,
  `.trim()`, `.length`, `.startsWith()` on strings/arrays — see `@keyma/ir`'s `intrinsics.md`)
  plus project-local utility functions. Arbitrary method calls are rejected.
- **`typeof x === "…"`** and **`x instanceof Date|RegExp|Uint8Array|Array`** are supported.
- A validator/formatter's `value` parameter **must declare a concrete type** (no `any`/`unknown`).

Constructs outside this subset are reported with stable `KEYMA08x` (bodies) / `KEYMA014`
(getters) diagnostics — see `@keyma/compiler-frontend-ts`'s `diagnostics.md`.

### Methods and setters

A `@Schema` class may declare plain instance **methods** and **setters**. Unlike `@Computed`
getters (which become stored, materialized fields), these are **behaviors**: code re-emitted
onto the generated model class in every target, not part of the persisted record.

```typescript
@Schema() class User {
    declare firstName: string;
    declare email: string;

    // Method: params + return type required; `this.<field>` reads fields.
    greeting(prefix: string): string {
        return `${prefix} ${this.firstName.toUpperCase()}`;
    }

    // Setter: a virtual writable property that normalizes into stored fields.
    set primaryEmail(value: string) {
        this.email = value.trim();
    }
}
```

Rules:

- Bodies use the **portable subset** above, plus `this.<field> = …` assignment. `this.<field>`
  reads/writes the record; parameters and `const`s are plain locals.
- **Signatures must be explicitly typed** — every parameter, and a method's return type
  (use `: void` for none). Untyped signatures are rejected with `KEYMA092`.
- **Async/generator** methods are not portable (`KEYMA082`).
- Visibility follows the TS modifier: a `private` method is emitted only into the server
  bundle, a public one into both client and server.
- A method's name must be unique among members; a **setter** may share a name with a field —
  e.g. a `@Computed` getter and a `set` of the same name form a get/set pair.

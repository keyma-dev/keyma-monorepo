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
import { Schema, Validate, Indexed, Format } from "@keyma/dsl";

@Schema({ name: "user" })
class User {
    @Validate(isRequired)
    @Indexed({ unique: true })
    readonly id: ID;

    @Validate(isRequired, isEmailAddress, maxLength(255))
    @Format("save", normalizeEmail)
    @Indexed({ unique: true })
    email: string;

    @Validate(isRequired, minLength(2), maxLength(64))
    @Format("change", trim)
    firstName: string;

    @Validate(oneOf(["admin", "member", "guest"]))
    role: "admin" | "member" | "guest";

    get displayName() {
        return `${this.firstName} ${this.lastName}`;
    }
}
```

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
| `Nullable<T>` | `{ kind: "nullable", of: T }` | T or null |
| `Reference<T>` | `{ kind: "reference", schema }` | Foreign reference (stores ID) |
| `Embedded<T>` | `{ kind: "embedded", schema }` | Inline sub-document |

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

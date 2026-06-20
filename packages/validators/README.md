# @keyma/validators

The built-in **validator** library for Keyma. Import these factories into your schemas and pass them to `@Validate(...)`. They cover length, range, numeric, date, array, and string-format checks.

This package is **pure-TypeScript source** — each validator is a plain factory function returning a `ValidatorFn` (see `src/validators.ts`). It is never compiled by Keyma; its `package.json` resolves to `src/*.ts`, and the compiler loads that source directly and re-emits the bodies of the validators you actually use into your generated bundle. There is no runtime registry.

## Usage

```ts
import { Schema, Validate } from "@keyma/dsl";
import type { ID } from "@keyma/dsl";
import { isEmail, minLength, maxLength, min, oneOf } from "@keyma/validators";

@Schema({ name: "user" })
class User {
    declare readonly id: ID;

    @Validate(isEmail(), maxLength(255))
    declare email: string;

    @Validate(minLength(2), maxLength(64))
    declare name: string;

    @Validate(min(0))
    declare age: number;

    @Validate(oneOf("admin", "member", "guest"))
    declare role: string;
}
```

These are **factory functions — call them** (`minLength(2)`, `isEmail()`). Each returns a `ValidatorFn` that the compiler lowers and re-emits directly into the schema's metadata.

> There is **no `required` validator.** A field's required-ness is inferred from optionality — a non-optional field (`name: string`) is required; an optional one (`name?: string`) is not. Null-ness is the orthogonal axis, expressed with `Nullable<T>`.

## Validators

| Marker | Arguments | IR kind |
|---|---|---|
| `minLength(n)` | `n: number` | `minLength` |
| `maxLength(n)` | `n: number` | `maxLength` |
| `length(n)` | `n: number` | `length` |
| `min(n)` | `n: number` | `min` |
| `max(n)` | `n: number` | `max` |
| `multipleOf(n)` | `n: number` | `multipleOf` |
| `isPositive()` | — | `positive` |
| `isNonNegative()` | — | `nonNegative` |
| `isNegative()` | — | `negative` |
| `isNonPositive()` | — | `nonPositive` |
| `isInteger()` | — | `integer` |
| `minDate(iso)` | `iso: string` | `minDate` |
| `maxDate(iso)` | `iso: string` | `maxDate` |
| `minItems(n)` | `n: number` | `minItems` |
| `maxItems(n)` | `n: number` | `maxItems` |
| `hasUniqueItems()` | — | `uniqueItems` |
| `isEmail()` | — | `emailAddress` |
| `isUrl()` | — | `url` |
| `isPhoneNumber()` | — | `phoneNumber` |
| `isIpAddress(version?)` | `"v4" \| "v6"` | `ipAddress` |
| `pattern(re, flags?)` | `re: string, flags?: string` | `pattern` |
| `oneOf(...values)` | `values: unknown[]` | `oneOf` |

## Custom validators

For project-specific rules, author your own as a plain factory function returning a `ValidatorFn`. The function name becomes the IR name; the body uses the **portable expression subset** so it re-emits in every target language (see `@keyma/dsl`):

```ts
import type { ValidatorFn } from "@keyma/dsl";

export function isSlug(): ValidatorFn<string> {
    return (value, field) =>
        /^[a-z0-9-]+$/.test(value)
            ? null
            : { field: field, code: "slug", message: `${field} must be a slug` };
}
```

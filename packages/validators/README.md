# @keyma/validators

The built-in **validator** library for Keyma. Import these markers into your schemas and pass them to `@Validate(...)`. They cover length, range, numeric, date, array, and string-format checks.

This package is itself a Keyma library: its validators are authored with the `Validator(...)` factory from `@keyma/dsl` and compiled by `keyma build` (its `build` script *is* `keyma build`). The compiled output in `dist/js` provides both the **authoring markers** used in your schema files and a **runtime registry** — `createValidatorRegistry()` returns the `Map<string, ValidatorFn>` that `@keyma/runtime-js`'s `validate()` consumes to actually run the checks.

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

Markers are **factory functions — call them** (`minLength(2)`, `isEmail()`). Each lowers to an `IRValidator` kind in the schema's IR.

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

For project-specific rules, author your own with the `Validator(...)` factory from `@keyma/dsl` and register the name under `customValidators` in your `keyma.config`. The body uses the **portable expression subset** so it can be re-emitted in every target language (see `@keyma/dsl` for the factory overloads and subset rules):

```ts
import { Validator } from "@keyma/dsl";

// Name inferred from the binding → "isSlug".
export const isSlug = Validator(() =>
    (value: string, field) =>
        /^[a-z0-9-]+$/.test(value)
            ? null
            : { field, code: "slug", message: `${field} must be a slug` });
```

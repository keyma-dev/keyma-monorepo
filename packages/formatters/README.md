# @keyma/formatters

The built-in **formatter** library for Keyma. Import these markers into your schemas and pass them to `@Format(phase, ...)`. Formatters normalize a field's value at a given lifecycle phase — `Change`, `Blur`, `Submit`, or `Save`.

Like `@keyma/validators`, this package is itself a Keyma library: its formatters are authored with the `Formatter(...)` factory from `@keyma/dsl` and compiled by `keyma build`. The compiled `dist/js` provides both the **authoring markers** and a **runtime registry** — `createFormatterRegistry()` returns the `Map<string, FormatterFn>` that `@keyma/runtime-js`'s `format()` consumes.

## Usage

```ts
import { Schema, Format, Phase } from "@keyma/dsl";
import { trim, normalizeEmail, slugify } from "@keyma/formatters";

@Schema({ name: "article" })
class Article {
    @Format(Phase.Change, trim())
    declare title: string;

    @Format(Phase.Save, slugify())
    declare slug: string;

    @Format(Phase.Save, normalizeEmail())
    declare contactEmail: string;
}
```

Markers are **factory functions — call them** (`trim()`). `Phase.Change` is identical to the bare string `"change"`. Client bundles include only the **form-phase** formatters (`Change`/`Blur`/`Submit`); `Save`-phase formatters run server-side only.

## Formatters

| Marker | Arguments | IR kind |
|---|---|---|
| `trim()` | — | `trim` |
| `lowercase()` | — | `lowercase` |
| `uppercase()` | — | `uppercase` |
| `capitalize()` | — | `capitalize` |
| `titleCase()` | — | `titleCase` |
| `normalizeWhitespace()` | — | `normalizeWhitespace` |
| `stripNonDigits()` | — | `stripNonDigits` |
| `normalizeEmail()` | — | `normalizeEmail` |
| `normalizeUrl()` | — | `normalizeUrl` |
| `normalizePhone()` | — | `normalizePhone` |
| `slugify()` | — | `slugify` |
| `truncate(maxLength)` | `maxLength: number` | `truncate` |

## Custom formatters

Author your own with the `Formatter(...)` factory from `@keyma/dsl` and register the name under `customFormatters` in your `keyma.config`. Bodies use the **portable expression subset** so they re-emit in every target language:

```ts
import { Formatter } from "@keyma/dsl";

// Name inferred from the binding → "collapseDashes".
export const collapseDashes = Formatter(() =>
    (value: string) => value.replace(/-+/g, "-"));
```

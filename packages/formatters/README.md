# @keyma/formatters

The built-in **formatter** library for Keyma. Import these markers into your schemas and pass them to `@Format(phase, ...)`. Formatters normalize a field's value at a given lifecycle phase — `Change`, `Blur`, `Submit`, or `Save`.

Like `@keyma/validators`, this package is **pure-TypeScript source** — each formatter is a plain factory function returning a `FormatterFn` (see `src/formatters.ts`). It is never compiled by Keyma; the compiler loads its source directly and re-emits the bodies of the formatters you use into your generated bundle. There is no runtime registry.

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

Author your own as a plain factory function returning a `FormatterFn`. The function name becomes the IR name; bodies use the **portable expression subset** so they re-emit in every target language:

```ts
import type { FormatterFn } from "@keyma/dsl";

export function collapseDashes(): FormatterFn<string> {
    return (value) => value.replace(/-+/g, "-");
}
```

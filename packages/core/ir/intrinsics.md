# Intrinsic operations

Some TypeScript expressions in validator/formatter/getter bodies cannot be emitted
verbatim into other target languages. `myStr.includes("x")` is valid TS and JS but
must become `"x" in myStr` in Python; `typeof x === "string"` must become
`isinstance(x, str)`; `x instanceof Date` must become `isinstance(x, datetime)`.

To keep the IR language-neutral, the TypeScript frontend recognizes a fixed set of
**intrinsic operations** and lowers them to a canonical IR node:

```ts
{ kind: "intrinsic"; op: string; receiver: IRExpression | null; args: IRExpression[] }
```

The set of intrinsics, their canonical `op` ids, receiver types, and arity live in
[`src/intrinsics.ts`](./src/intrinsics.ts) (`INTRINSICS`). That module is **pure
data and carries no target syntax** — it only answers "is this a known intrinsic,
and what is its canonical op id / receiver / arity". Each backend owns a translation
table keyed by `op`.

## Tiers — what a backend must vs should implement

- **`required`** — every backend MUST translate this op. Failing to handle a
  `required` op is a backend bug.
- **`recommended`** — a backend SHOULD translate this op, but MAY reject it (with a
  diagnostic) if the target language cannot express it cleanly.

## Registry

| op | receiver | TS form | tier |
|----|----------|---------|------|
| `string.includes` | string | `s.includes(x)` | required |
| `string.startsWith` | string | `s.startsWith(x)` | required |
| `string.endsWith` | string | `s.endsWith(x)` | required |
| `string.toLowerCase` | string | `s.toLowerCase()` | required |
| `string.toUpperCase` | string | `s.toUpperCase()` | required |
| `string.trim` | string | `s.trim()` | required |
| `string.length` | string | `s.length` | required |
| `string.indexOf` | string | `s.indexOf(x)` | recommended |
| `string.slice` | string | `s.slice(a[, b])` | recommended |
| `string.charAt` | string | `s.charAt(i)` | recommended |
| `string.replace` | string | `s.replace(pat, repl)` | recommended |
| `array.includes` | array | `a.includes(x)` | required |
| `array.length` | array | `a.length` | required |
| `array.indexOf` | array | `a.indexOf(x)` | recommended |
| `array.join` | array | `a.join([sep])` | recommended |
| `array.filter` | array | `a.filter(pred)` | recommended |
| `array.map` | array | `a.map(fn)` | recommended |
| `array.some` | array | `a.some(pred)` | recommended |
| `array.every` | array | `a.every(pred)` | recommended |
| `regexp.test` | regexp | `re.test(s)` | recommended |
| `date.getTime` | date | `d.getTime()` | recommended |
| `date.getFullYear` | date | `d.getFullYear()` | recommended |
| `date.getMonth` | date | `d.getMonth()` | recommended |
| `date.getDate` | date | `d.getDate()` | recommended |
| `date.getDay` | date | `d.getDay()` | recommended |
| `date.getHours` | date | `d.getHours()` | recommended |
| `date.getMinutes` | date | `d.getMinutes()` | recommended |
| `date.getSeconds` | date | `d.getSeconds()` | recommended |
| `date.getMilliseconds` | date | `d.getMilliseconds()` | recommended |
| `date.toISOString` | date | `d.toISOString()` | recommended |
| `date.now` | value | `Date.now()` | recommended |
| `math.floor` | value | `Math.floor(x)` | recommended |
| `math.ceil` | value | `Math.ceil(x)` | recommended |
| `math.round` | value | `Math.round(x)` | recommended |
| `math.trunc` | value | `Math.trunc(x)` | recommended |
| `math.abs` | value | `Math.abs(x)` | recommended |
| `math.sign` | value | `Math.sign(x)` | recommended |
| `math.sqrt` | value | `Math.sqrt(x)` | recommended |
| `math.pow` | value | `Math.pow(x, y)` | recommended |
| `math.min` | value | `Math.min(…)` | recommended |
| `math.max` | value | `Math.max(…)` | recommended |
| `to-string` | value | `String(x)` | recommended |
| `to-number` | value | `Number(x)` | recommended |
| `type-is` | value | `typeof x === "<name>"` | required |
| `instance-of` | value | `x instanceof Ctor` | required |

### `string.replace`, `array.filter`, `regexp.test`

These accept function/regex arguments, so backends branch on `args[0].kind`:

- **`string.replace(pat, repl)`** — `pat` may be a `regexp` node (or `new RegExp(...)`) or a plain string;
  `repl` may be a string or an `arrow` (function replacement, called with the matched substring). A regex
  with the `g` flag replaces all matches, without it only the first.
- **`array.filter(pred)` / `array.map(fn)` / `array.some(pred)` / `array.every(pred)`** — the
  argument is an `arrow` node `(x) => …` or `(x, i) => …`. JS backends emit the native method;
  Python emits a comprehension (`filter`/`map`) or `any(...)`/`all(...)` (`some`/`every`) for an
  expression-body arrow, falling back to the functional form over a hoisted nested `def` for a
  block-body arrow; C++ emits `keyma::filter/map/some/every` runtime helpers.
- **`regexp.test(s)`** — the receiver is a regex literal or a `new RegExp(...)` expression.

### `type-is` and `instance-of`

These are synthesized by the frontend, not member calls:

- `typeof x === "string"` → `{ kind: "intrinsic", op: "type-is", receiver: x, args: [{ kind: "literal", value: "string" }] }`.
  The literal is the standard `typeof` string (`"string"`, `"number"`, `"boolean"`,
  `"object"`, `"undefined"`, `"function"`). A negated form (`typeof x !== "string"`)
  lowers to the same intrinsic wrapped in a `unary "!"`.
  > Note: `"number"` must map to a numeric check that excludes booleans
  > (e.g. Python `isinstance(x, (int, float)) and not isinstance(x, bool)`).
- `x instanceof Date` → `{ kind: "intrinsic", op: "instance-of", receiver: x, args: [{ kind: "literal", value: "Date" }] }`.
  The right-hand side is restricted to the portable global constructors the frontend
  knows how to map (`Date`, `RegExp`, `Uint8Array`, …); any other constructor is a
  compile error (`KEYMA087`).

### Date intrinsics (`date.*`) and `new Date(...)`

The `date` receiver covers a fixed set of **read-only** accessors on a `Date` value
(`DateTime` fields and `new Date()` results). Date **mutators** (`setHours`, …) and the
UTC/locale variants (`getUTCHours`, `toLocaleDateString`, …) are intentionally *not* in the
registry — calling them is a non-portable error (`KEYMA085`).

Backends must account for JS↔target semantic offsets:

- `getMonth` is **0-based** (`0` = January); a 1-based target subtracts 1.
- `getDay` is **0 = Sunday**; a Monday-based target (e.g. Python `weekday()`) maps via `(n + 1) % 7`.
- `getTime` / `Date.now()` are **milliseconds** since the epoch; a seconds-based target scales by 1000.
- `getMilliseconds` is the millisecond component; a microsecond target divides by 1000.
- `toISOString` is **UTC** with a trailing `Z` and exactly 3 fractional digits.

`Date.now()` is the only **static** date op. The frontend synthesizes it (no instance receiver)
to `{ kind: "intrinsic", op: "date.now", receiver: null, args: [] }`; resolve it via `intrinsicByOp`.

The **`new Date(...)` constructor** is *not* an intrinsic — it stays a `new` IR node
(`{ kind: "new", callee: { kind: "identifier", name: "Date" }, args }`) that each backend maps in
its `new`-expression handler (the JS backend re-emits it verbatim). A target may legitimately diverge
from JS on out-of-range component rollover and on lenient (non-ISO) string parsing; backends should
document their chosen policy.

### Math numerics (`math.*`)

The `math.*` ops are **free-standing** (`receiver: null`) — the frontend recognizes a
`Math.<fn>(...)` call on the global `Math` object and synthesizes the intrinsic with the call
arguments in `args` (so they are not member intrinsics and carry an empty `tsName`). `math.pow`
takes exactly 2 args; `math.min`/`math.max` are variadic (≥ 1 arg); the rest take 1.

Backends must reproduce JS numeric semantics where they diverge from the target stdlib:

- `Math.round` rounds **half toward +Infinity** (`Math.round(2.5) === 3`, `Math.round(-2.5) === -2`),
  *not* banker's rounding. Python (`round`) and C++ have no built-in for this — both route through a
  runtime shim (`keyma.runtime.math_round`, `keyma::math_round`).
- `Math.trunc` truncates toward zero and `Math.sign` returns `-1`/`0`/`1`; both pass `NaN`/`±Infinity`
  through unchanged and preserve signed zero. Python/C++ route these through runtime shims
  (`math_trunc`/`math_sign`) for the NaN/Infinity edge cases.
- `floor`/`ceil`/`sqrt`/`pow`/`abs`/`min`/`max` map onto the target stdlib/builtins directly (JS
  `Math.*`; Python `math.*` / builtins; C++ `keyma::*`).

### `String()` / `Number()` coercion (`to-string` / `to-number`)

Free-standing single-arg coercions, recognized from a bare `String(x)` / `Number(x)` call. They
follow JS coercion rules (`String(null) === "null"`, `String(true) === "true"`, integral numbers
print without a trailing `.0`; `Number("") === 0`, `Number(true) === 1`, non-numeric strings → `NaN`).
JS emits the native `String(x)`/`Number(x)`; Python and C++ route through runtime helpers
(`keyma.runtime.to_string`/`to_number`, `keyma::to_string`/`keyma::to_number`) that reproduce those
rules — the target's own string/number conversions differ (Python `str(3.0) === "3.0"`, banker's
rounding, `int("")` raising, etc.).

## Adding an intrinsic

1. Add an entry to `INTRINSICS` in `src/intrinsics.ts` with a unique `op`.
2. Teach the frontend recognizer to emit it (`compiler-frontend-ts`).
3. Add a translation for the new `op` to **every** backend's `emit-expression`
   table (`required`) or at least handle/reject it (`recommended`).

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
| `regexp.test` | regexp | `re.test(s)` | recommended |
| `type-is` | value | `typeof x === "<name>"` | required |
| `instance-of` | value | `x instanceof Ctor` | required |

### `string.replace`, `array.filter`, `regexp.test`

These accept function/regex arguments, so backends branch on `args[0].kind`:

- **`string.replace(pat, repl)`** — `pat` may be a `regexp` node (or `new RegExp(...)`) or a plain string;
  `repl` may be a string or an `arrow` (function replacement, called with the matched substring). A regex
  with the `g` flag replaces all matches, without it only the first.
- **`array.filter(pred)`** — `pred` is an `arrow` node `(x) => …` or `(x, i) => …`.
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

## Adding an intrinsic

1. Add an entry to `INTRINSICS` in `src/intrinsics.ts` with a unique `op`.
2. Teach the frontend recognizer to emit it (`compiler-frontend-ts`).
3. Add a translation for the new `op` to **every** backend's `emit-expression`
   table (`required`) or at least handle/reject it (`recommended`).

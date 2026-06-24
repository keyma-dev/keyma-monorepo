# Keyma playground

A small but **complete** schema library that exercises the full `@keyma/dsl`
surface, compiled by `keyma build` and tested **end-to-end** against the
generated JS bundle with the in-memory adapter — i.e. exactly how a real
consumer would use Keyma.

## Layout

```
src/                 authored schemas (compiled by `keyma build`)
  base.ts            abstract @Schema Entity (inherited id + timestamps, Now())
  author.ts          Author: validators, all 4 format phases, FormField, enum,
                     Bytes, Nullable, @Deprecated, getter/setter accessor pair,
                     standalone setter, instance method, a private field
  post.ts            Post + embedded Seo: references, arrays, Decimal/DateOnly/
                     TimeOfDay/Json/Regexp, composite + text + unique indexes,
                     ephemeral field, getter accessor
  comment.ts         Comment: references, length/isIpAddress, uppercase
  tag.ts             Tag: node schema for edges
  credentials.ts     a PRIVATE @Schema (excluded from the client bundle)
  graph.ts           @Edge Follows (directed) and Related (undirected)
  services.ts        @Service AccountService (public) + AdminService (private),
                     ephemeral inputs/outputs, a cross-field validator
  showcase.ts        fills in the remaining built-in validators/formatters
  lib/               project-local custom validators + formatters
dist/                generated output (`keyma build`) — js/{client,server} + python
test/                node:test suites run directly on *.test.ts (node 22+)
  setup.ts           shared harness: makeHarness(), seed(), valid* factories
```

## Build

```bash
keyma build        # generates dist/js/{client,server} and dist/python/{client,server}
```

`dist/js/server/index.js` re-exports every schema class (each carrying its frozen
`static schema` metadata) plus the service contracts; the client bundle omits
private schemas/fields, indexes and defaults.

## Test

Tests run **directly on the TypeScript sources** — node 22+ strips the types, so
there is no separate compile step for the test files:

```bash
npm test           # runs `keyma build` (pretest) then `node --test "test/**/*.test.ts"`
# or a single file:
node --test test/crud.test.ts
```

The suites import the generated bundle from `dist/js/server`, stand up a
`KeymaServer` over `InMemoryAdapter` from `@keyma/runtime-js/testing`, and drive
it through the `Keyma` query/mutation builder and the `validate` / `format` /
`serialize` / `applyDefaults` helpers — covering CRUD, validation
(built-in, custom and cross-field), formatting per phase, defaults, getter
accessors, serialization visibility, graph edges, RPC services and the generated
metadata shape.

> Requires the workspace packages to be built first (`npm run build` at the repo
> root) so `keyma` and `@keyma/runtime-js` resolve to their compiled output.

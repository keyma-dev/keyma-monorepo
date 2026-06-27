# Running the Keyma TS frontend (and JS backend) in the browser

`@keyma/compiler/frontend-ts` and `@keyma/compiler/backend-js` are **dependency-free of
Node** and run entirely in the browser. They use only path-string math (via
`@keyma/core/util`, not `node:path`) and, for the frontend, an injected in-memory
TypeScript filesystem (`@typescript/vfs`). Nothing reads the real filesystem.

## Backend — no setup

`emitJs(ir, target, config)` is pure (`IR → EmitFile[]`). Import and call it directly; it
touches no filesystem.

## Frontend — bring an in-memory `ts.System`

The frontend type-checks user sources with `ts.createProgram`. In the browser you provide a
`ts.System` from `@typescript/vfs`, pre-loaded with everything module resolution needs, and
pass it as `config.system`:

```ts
import { createSystem, createDefaultMapFromCDN } from "@typescript/vfs";
import ts from "typescript";
import { compileVirtual } from "@keyma/compiler/frontend-ts";

// 1. TypeScript standard library .d.ts files (lib.es2022.*, lib.decorators*, …).
//    createDefaultMapFromCDN fetches them; or bundle them yourself as strings.
const map = await createDefaultMapFromCDN(
    { target: ts.ScriptTarget.ES2022 },
    ts.version,
    true,
    ts,
);

// 2. The Keyma authoring packages your sources import, laid out under a FLAT
//    /node_modules/@keyma tree so NodeNext resolves the bare imports from both the user files
//    and from any library packages those files pull in. This is always `@keyma/core` (the core
//    DSL) plus whatever domain package(s) your sources use.
//    Mirror each package's real layout exactly — its package.json `exports`/`types` and the
//    file they resolve to must both be present, byte-faithful, at the right virtual path:
//      /node_modules/@keyma/core/package.json
//      /node_modules/@keyma/core/dist/src/dsl/{index,types}.d.ts
//      …plus the same for each domain package you depend on.
//    Ship these as a static asset bundled with your app (e.g. a generated { path: content } map).
for (const [virtualPath, content] of Object.entries(KEYMA_PACKAGE_FILES)) {
    map.set(virtualPath, content);
}

const system = createSystem(map);

// 3. Compile your sources fully in memory.
const { ir, diagnostics } = compileVirtual(
    {
        "user.ts": `
            import type { Integer } from "@keyma/core/dsl";
            class User {
                declare id: string;
                declare name: string;
                declare age: Integer<8>;
            }
        `,
    },
    { system, domains: [/* the domain frontends you register */] },
);
```

`compileVirtual` writes your sources into the system's map and runs entirely in memory. From
there, feed `ir` to `emitJs` (or any backend) — also in-browser.

### Notes

- **Decorator libs are required.** `experimentalDecorators` needs `lib.decorators.d.ts` and
  `lib.decorators.legacy.d.ts` in the map. `createDefaultMapFromCDN` includes them; if you
  hand-pick libs, add them explicitly.
- **`sourceRoot`** in the resulting IR is the virtual base (default `/`), not a disk path.
- **Don't override `dslModuleName`** in browser mode — sources import the literal `@keyma/core/dsl`.

## Node / SSR / tests — `@keyma/compiler/frontend-ts/node`

To build the same virtual `ts.System` from disk (for SSR or tests), use the Node-only helper —
it reads the TS libs and the `@keyma/*` sources once and returns a no-further-IO system. It
always vendors `@keyma/core`; pass `packages` to add the domain package(s) your sources import:

```ts
import { createKeymaNodeSystem } from "@keyma/compiler/frontend-ts/node";
const system = createKeymaNodeSystem({ packages: ["@keyma/your-domain"] });
const { ir } = compileVirtual({ "user.ts": "/* … */" }, { system });
```

The Node CLI path is unchanged: `compile({ files })` still reads from disk via the normal
TypeScript host when no `system` is supplied.

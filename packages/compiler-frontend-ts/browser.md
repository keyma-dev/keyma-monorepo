# Running the Keyma TS frontend (and JS backend) in the browser

`@keyma/compiler-frontend-ts` and `@keyma/compiler-backend-js` are **dependency-free of
Node** and run entirely in the browser. They use only path-string math (via
`@keyma/compiler-util`, not `node:path`) and, for the frontend, an injected in-memory
TypeScript filesystem (`@typescript/vfs`). Nothing reads the real filesystem.

## Backend — no setup

`emitJs(ir, target, config)` is pure (`IR → EmitFile[]`). Import and call it directly; it
touches no filesystem.

## Frontend — bring an in-memory `ts.System`

The frontend type-checks user schemas with `ts.createProgram`. In the browser you provide a
`ts.System` from `@typescript/vfs`, pre-loaded with everything module resolution needs, and
pass it as `config.system`:

```ts
import { createSystem, createDefaultMapFromCDN } from "@typescript/vfs";
import ts from "typescript";
import { compileVirtual } from "@keyma/compiler-frontend-ts";

// 1. TypeScript standard library .d.ts files (lib.es2022.*, lib.decorators*, …).
//    createDefaultMapFromCDN fetches them; or bundle them yourself as strings.
const map = await createDefaultMapFromCDN(
    { target: ts.ScriptTarget.ES2022 },
    ts.version,
    true,
    ts,
);

// 2. The Keyma authoring packages, laid out under a FLAT /node_modules/@keyma tree so
//    NodeNext resolves the bare `@keyma/dsl` import from both the user files and from the
//    validator/formatter libraries (which themselves import `@keyma/dsl`).
//    Mirror each package's real layout exactly — its package.json `exports`/`types` and the
//    file they resolve to must both be present, byte-faithful, at the right virtual path:
//      /node_modules/@keyma/dsl/package.json
//      /node_modules/@keyma/dsl/dist/src/{index,types,decorators}.d.ts
//      /node_modules/@keyma/validators/package.json
//      /node_modules/@keyma/validators/src/{index,validators}.ts
//      /node_modules/@keyma/formatters/package.json
//      /node_modules/@keyma/formatters/src/{index,formatters}.ts
//    Ship these as a static asset bundled with your app (e.g. a generated { path: content } map).
for (const [virtualPath, content] of Object.entries(KEYMA_PACKAGE_FILES)) {
    map.set(virtualPath, content);
}

const system = createSystem(map);

// 3. Compile your schema sources fully in memory.
const { ir, diagnostics } = compileVirtual(
    {
        "user.ts": `
            import { Schema, Validate } from "@keyma/dsl";
            import { minLength } from "@keyma/validators";
            @Schema() class User {
                declare id: string;
                @Validate(minLength(3)) declare name: string;
            }
        `,
    },
    { system },
);
```

`compileVirtual` writes your sources into the system's map and runs entirely in memory. From
there, feed `ir` to `emitJs` (or any backend) — also in-browser.

### Notes

- **Decorator libs are required.** `experimentalDecorators` needs `lib.decorators.d.ts` and
  `lib.decorators.legacy.d.ts` in the map. `createDefaultMapFromCDN` includes them; if you
  hand-pick libs, add them explicitly.
- **`sourceRoot`** in the resulting IR is the virtual base (default `/`), not a disk path.
- **Don't override `dslModuleName`** in browser mode unless you also remap the validator/
  formatter libraries — they import the literal `@keyma/dsl`.

## Node / SSR / tests — `@keyma/compiler-frontend-ts/node`

To build the same virtual `ts.System` from disk (for SSR or tests), use the Node-only helper —
it reads the TS libs and the `@keyma/*` sources once and returns a no-further-IO system:

```ts
import { createKeymaNodeSystem } from "@keyma/compiler-frontend-ts/node";
const system = createKeymaNodeSystem();
const { ir } = compileVirtual({ "user.ts": "/* … */" }, { system });
```

The Node CLI path is unchanged: `compile({ files })` still reads from disk via the normal
TypeScript host when no `system` is supplied.

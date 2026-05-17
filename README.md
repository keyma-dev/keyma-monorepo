# Keyma

A declarative schema compiler for full-stack applications.

You define data models, validation rules, formatting behavior, database indexes, computed fields, and relationships in TypeScript. Keyma then compiles those schemas into small, dependency-light target libraries for runtimes such as JavaScript and C++.

The generated schema libraries do **not** depend on `reflect-metadata`, `tslib`, TypeScript decorator emit helpers, or any other runtime reflection mechanism. They are paired with tiny target runtimes such as `@keyma/runtime-js` or `@keyma/runtime-cpp`.

## Introduction

**Keyma** lets you express data models, relationships, and form input requirements once, in a unified declarative way, and use them everywhere.

* **Declarative**: Define your data models and relationships using clear, concise decorators.
* **Compiled**: TypeScript is the authoring language. Keyma parses your source via the TypeScript compiler API, builds a language-neutral intermediate representation (IR), and emits target-specific code.
* **Full Stack**: Write once and consume your schemas on both the client and server. Keyma produces two distinct generated libraries: one for backend (with private fields and server-only schemas) and one for frontend (with only public surface area).
* **Multi-Language**: The compiler has a frontend/backend architecture. The built-in frontend reads TypeScript. Backends can target any language. A built-in JavaScript backend is provided. C++ and others can be added.
* **Lightweight Output**: Generated code is plain — no decorators, no reflect-metadata, no tslib. Only a small runtime library is required at consumption time.
* **Scaffolding**: A simple CLI generates projects, schema files, and build outputs.

Whether you are building a simple CRUD app or a complex, relational system, **Keyma** bridges the gap between data modeling and application logic — across languages.

---

## Architecture Overview


- TypeScript schema source files
- TypeScript compiler frontend (uses the TypeScript compiler API)
- Keyma language-neutral IR (.keyma/schema.ir.json)
- Code generation backends (JS, C++, ...)
- Generated schema library + small runtime (@keyma/runtime-js, @keyma/runtime-cpp, ...)

Decorators in the schema source are **compile-time annotations**, not runtime behavior. The Keyma compiler reads them from the AST. They are never executed and never emitted into the compiled output.

---

## Installation

```shell
npm i -g @keyma/keyma
```
## Usage

First, generate a new project using the CLI.

```shell
keyma new my-project
cd my-project
```


This will generate a new Keyma project and change the command directory to the project directory. Now let's create a data model.

```shell
keyma gen user
```

A new file called **user.ts** will be created in the **src** directory and should look like this:

```typescript
import { Schema, ID } from "@keyma/dsl";

@Schema({
    name: "user",
})
export class User {
    readonly id: ID;
}
```


Let's add some fields with validation to our User model:

```typescript
import { Schema, ID, Validate } from "@keyma/dsl";
import { isRequired, minLength, maxLength, isEmailAddress } from "@keyma/dsl";

@Schema({
    name: "user",
})
export class User {
    readonly id: ID;

    @Validate(isRequired, minLength(2), maxLength(32))
    firstName: string;

    @Validate(isRequired, minLength(2), maxLength(32))
    lastName: string;

    @Validate(isRequired, isEmailAddress)
    email: string;
}
```


We'll want to store users in a database, so we'll declare how it's indexed. We can also add internal fields:

```typescript
import { Schema, ID, Validate, Indexed } from "@keyma/dsl";
import { isRequired, minLength, maxLength, isEmailAddress } from "@keyma/dsl";

@Schema({
    name: "user",
})
export class User {
    readonly id: ID;

    @Validate(isRequired, minLength(2), maxLength(32))
    firstName: string;

    @Validate(isRequired, minLength(2), maxLength(32))
    lastName: string;

    @Validate(isRequired, isEmailAddress)
    @Indexed({ unique: true })
    email: string;

    @Indexed()
    get fullName() {
        return `${this.firstName} ${this.lastName}`;
    }

    // `private` fields are detected by the compiler from the AST.
    // They are stripped from the generated client library and are not
    // settable from client input.
    private secretMessage: string;
}
```


The getter-only property `fullName` is treated as a **computed field**. Because it is `@Indexed()`, the compiler will:

* materialize its value on every write (the backend stores it as a real column/document field),
* expose it as an index in the generated server library,
* expose it as a normal getter on the client.

Computed getters must be expressible in Keyma's **portable expression subset** (field access, literals, template strings, basic operators, conditional expressions). The compiler will emit a diagnostic if a getter uses unsupported constructs, so that the same field can be generated correctly across all target languages.

Let's add formatting and form behavior:

```typescript
import { Schema, ID, Validate, Indexed, Format, Ephemeral } from "@keyma/dsl";
import { isRequired, minLength, maxLength, isEmailAddress } from "@keyma/dsl";
import { trim, normalizeEmail } from "@keyma/dsl";

@Schema({
	name: "user",
})
export class User {
	readonly id: ID;

	@Validate(isRequired, minLength(2), maxLength(32))
	@Format("change", trim)
	firstName: string;

	@Validate(isRequired, minLength(2), maxLength(32))
	@Format("change", trim)
	lastName: string;

	@Validate(isRequired, isEmailAddress)
	@Indexed({unique: true})
	@Format("change", normalizeEmail)
	email: string;

	@Indexed()
	get fullName() {
		return `${this.firstName} ${this.lastName}`;
	}

	@Ephemeral() // not stored in the database, but can go over the wire
    computedAtRuntime: string;

	private secretMessage: string;
}
```


References to other schemas use `Reference<T>` (stored ID, fetched separately) or `Embedded<T>` (inline sub-document). A bare class type also means reference, but `Reference<T>` makes the intent explicit. Schemas can be marked `private` to make them entirely server-only:

```typescript
import { Schema, ID, Validate, Indexed, Reference, Nullable } from "@keyma/dsl";

@Schema({
    name: "user_credentials",
    private: true, // server-only schema, not emitted in the client output
})
export class UserCredentials {
    readonly id: ID;

    @Indexed()
    user: Reference<User>;

    @Indexed()
    get username() {
        return this.user.email;
    }

    hashedPassword: string;
    totpRFC6238: Nullable<string>;
}
```


## Compiling

```shell
keyma build
```


By default, this produces:

```
dist/
  js/
    client/
      index.js
      index.d.ts
    server/
      index.js
      index.d.ts
.keyma/
  schema.ir.json
```


The generated JavaScript is plain ES modules. It contains:

* generated model classes (no decorators),
* static schema metadata objects,
* typed `.d.ts` files.

It depends only on the small `@keyma/runtime-js` runtime.

Backends are pluggable. Configure additional targets in `keyma.config.ts`:

```typescript
export default {
    source: "src/**/*.ts",
    outDir: "dist",
    targets: [
        { language: "js", client: true, server: true },
        { language: "cpp" }
    ]
};
```


## Server-side implementation

The server-side library is consumed with the `@keyma/runtime-js` runtime and a database adapter (for example, `@keyma/adapter-mongodb-js`):

```typescript
import { KeymaServer } from "@keyma/runtime-js/server";
import { MongoAdapter } from "@keyma/adapter-mongodb-js";
import { schemas } from "./generated/server";

const server = new KeymaServer({
    schemas,
    adapter: new MongoAdapter({ url: "mongodb://localhost:27017", db: "myapp" })
    });

await server.sync(); // creates collections and indexes
```


## Querying data

Once the backend exposes the query endpoint, the client can build typed, declarative queries:

```typescript

// Build a query template
const query = Keyma.query({
    users: Keyma.list(User, /* where: */{
		email: Keyma.input('emailSearch'), // placeholder for request time substitution
        active: true, // static value, sent with request but cannot be changed at request time
	}, /* projection: */{
		id: 1,
        email: 1,
        firstName: 1,
        lastName: 1
    }),
    user: Keyma.read(User, /* where: */{
        id: Keyma.input('userId')
    }, /* projection: */{
	    id: 1,
		email: 1,
		firstName: 1,
		lastName: 1,
        createdOn: 1
    })
});

async function listUsers(skip: number, limit: number, inputs: typeof query.inputs) {
    const response = await query.request({
        users: {
            skip,
            limit,
            sort : {
                createdOn: -1
            }
        },
        user: {} // empty options for this leaf, can be omitted
    }, {inputs, transport});

    return response;
}
```


The query API serializes to a portable, language-neutral query document — not executable code — so it can be issued from any Keyma client runtime.

## Why a compiler, not runtime decorators?

Traditional decorator-based TypeScript schema libraries depend on `reflect-metadata`, decorator emit helpers, and `tslib`. They cannot:

* reliably detect `private` fields,
* Emit type metadata for generics
* generate code for non-JavaScript runtimes,
* fully separate client and server output,
* statically validate computed expressions for portability,
* produce dependency-free generated libraries.

Keyma sidesteps all of those limitations by treating TypeScript as an authoring DSL and generating plain, statically-defined libraries from a stable IR.

## Status

Keyma is under active development.

## License

MIT

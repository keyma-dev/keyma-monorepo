/**
 * Shared end-to-end test harness.
 *
 * Tests run directly on the *.test.ts sources (node 24 strips the types) and
 * import the *generated* server bundle from `dist/js/server` — exactly what a
 * consumer of this schema library would do. `keyma build` must run first
 * (the `pretest` script handles that).
 */
import { KeymaServer, createDirectTransport } from "@keyma/runtime-js";
import type { RequestContext, ServiceProvider } from "@keyma/runtime-js";
import { InMemoryAdapter } from "@keyma/runtime-js/testing";

import {
    Author,
    Post,
    Seo,
    Comment,
    Tag,
    Credentials,
    Follows,
    Related,
    Showcase,
    SignupInput,
    SignupResult,
    InviteInput,
    InviteResult,
    AccountService,
    AdminService,
    materializeAuthor,
    materializePost,
    materializeCredentials,
} from "../dist/js/server/index.js";

// Re-export the generated classes so test files have a single import site.
export {
    Author,
    Post,
    Seo,
    Comment,
    Tag,
    Credentials,
    Follows,
    Related,
    Showcase,
    SignupInput,
    SignupResult,
    InviteInput,
    InviteResult,
    AccountService,
    AdminService,
    materializeAuthor,
    materializePost,
    materializeCredentials,
};

/** Every schema the server should know about (persisted + ephemeral wire types). */
export const ALL_SCHEMAS = [
    Author.schema,
    Post.schema,
    Seo.schema,
    Comment.schema,
    Tag.schema,
    Credentials.schema,
    Follows.schema,
    Related.schema,
    Showcase.schema,
    SignupInput.schema,
    SignupResult.schema,
    InviteInput.schema,
    InviteResult.schema,
];

let tokenSeq = 0;

/** A working implementation of the generated AccountService contract. */
export class AccountServiceImpl extends AccountService {
    invites: { id: string; email: string; token: string }[] = [];

    async signup(input: SignupInput): Promise<SignupResult> {
        return { id: `acct-${++tokenSeq}`, token: `tok-${tokenSeq}` };
    }

    async invite(input: InviteInput): Promise<InviteResult> {
        const rec = { id: `inv-${++tokenSeq}`, email: input.email, token: `tok-${tokenSeq}` };
        this.invites.push(rec);
        return { id: rec.id, token: rec.token };
    }

    async resend(email: string): Promise<boolean> {
        return this.invites.some((i) => i.email === email);
    }

    async pending(): Promise<InviteResult[]> {
        return this.invites.map((i) => ({ id: i.id, token: i.token }));
    }
}

/** A working implementation of the generated (private) AdminService contract. */
export class AdminServiceImpl extends AdminService {
    purged: string[] = [];

    async purge(email: string): Promise<boolean> {
        this.purged.push(email);
        return true;
    }

    async stats(): Promise<unknown> {
        return { purged: this.purged.length };
    }
}

export type Harness = {
    server: KeymaServer;
    adapter: InMemoryAdapter;
    transport: ReturnType<typeof createDirectTransport>;
    account: AccountServiceImpl;
    admin: AdminServiceImpl;
};

/**
 * Build a fresh server backed by an in-memory adapter and a direct transport.
 * `context` lets a test impersonate a system identity (needed to reach private
 * services); it is threaded through every request.
 */
export function makeHarness(context: RequestContext = {}): Harness {
    const adapter = new InMemoryAdapter();
    const account = new AccountServiceImpl();
    const admin = new AdminServiceImpl();
    const services: ServiceProvider[] = [account, admin];
    const server = new KeymaServer({ schemas: ALL_SCHEMAS, adapter, services });
    const transport = createDirectTransport(server, () => context);
    return { server, adapter, transport, account, admin };
}

/** Seed an adapter store directly (bypassing validation), keyed by schema name. */
export function seed(
    adapter: InMemoryAdapter,
    schemaName: string,
    rows: Record<string, Record<string, unknown>>,
): void {
    adapter.stores.set(schemaName, new Map(Object.entries(rows)));
}

// ── Valid-payload factories ──────────────────────────────────────────────────
//
// A field carrying a `@Validate(...)` is rejected when absent: the backend wraps
// each validator in a `typeof` guard, so `undefined` fails as a "wrong type".
// These factories return fully-valid create payloads (every validated field
// present); tests override a single field to probe one rule at a time.

type Obj = Record<string, unknown>;

export function validAuthor(overrides: Obj = {}): Obj {
    return {
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Ng",
        username: "alice_ng",
        website: "https://alice.example.com",
        phone: "+15551234567",
        bio: "Writer of things.",
        ...overrides,
    };
}

export function validPost(overrides: Obj = {}): Obj {
    return {
        title: "My First Post",
        slug: "my-first-post",
        body: "Hello world, this is the body.",
        excerpt: "A short excerpt.",
        tags: ["intro", "news"],
        author: "a1",
        price: "9.99",
        publishedOn: "2024-01-01",
        ...overrides,
    };
}

export function validComment(overrides: Obj = {}): Obj {
    return {
        body: "Nice post!",
        author: "a1",
        post: "p1",
        countryCode: "US",
        authorIp: "192.168.1.1",
        ...overrides,
    };
}

export function validTag(overrides: Obj = {}): Obj {
    return { label: "News", slug: "news", ...overrides };
}

export function validShowcase(overrides: Obj = {}): Obj {
    return { nationalId: "12345", ipv6: "::1", ...overrides };
}

export function validSignupInput(overrides: Obj = {}): Obj {
    return {
        email: "new@example.com",
        password: "supersecret",
        confirmPassword: "supersecret",
        ...overrides,
    };
}

export function validInviteInput(overrides: Obj = {}): Obj {
    return { email: "invitee@example.com", message: "Join us!", ...overrides };
}

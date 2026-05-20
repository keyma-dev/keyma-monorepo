/** Deterministic 24-char hex id from a (kind, index) pair. Compatible with
 *  MongoDB ObjectId-shaped strings and with adapters that accept arbitrary
 *  string ids. The high nibbles encode the kind so different entity kinds
 *  never collide. */
export function id(kind: number, index: number): string {
    const k = (kind & 0xff).toString(16).padStart(2, "0");
    const i = index.toString(16).padStart(22, "0");
    return k + i;
}

export const IdKind = {
    User: 0x01,
    Org: 0x02,
    Post: 0x03,
    Tag: 0x04,
    Authorship: 0x05,
    Tagging: 0x06,
    Friendship: 0x07,
} as const;

export function mkOrgs(n: number): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < n; i++) {
        out.push({ id: id(IdKind.Org, i), name: "org-" + i });
    }
    return out;
}

export function mkUsers(n: number, orgCount = 0): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < n; i++) {
        const u: Record<string, unknown> = {
            id: id(IdKind.User, i),
            email: "u" + i + "@bench.local",
            name: "user-" + i.toString().padStart(8, "0"),
            age: 18 + (i % 60),
        };
        if (orgCount > 0) u["organization"] = id(IdKind.Org, i % orgCount);
        out.push(u);
    }
    return out;
}

export function mkPosts(n: number): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < n; i++) {
        out.push({ id: id(IdKind.Post, i), title: "post-" + i });
    }
    return out;
}

export function mkTags(n: number): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < n; i++) {
        out.push({ id: id(IdKind.Tag, i), label: "tag-" + i });
    }
    return out;
}

/** One authorship edge per post; round-robin over `userCount` authors. */
export function mkAuthorship(
    userCount: number,
    postCount: number,
): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < postCount; i++) {
        out.push({
            id: id(IdKind.Authorship, i),
            author: id(IdKind.User, i % userCount),
            post: id(IdKind.Post, i),
        });
    }
    return out;
}

/** Two taggings per post (round-robin over `tagCount`) so traversal fanout
 *  is non-trivial. */
export function mkTagging(
    postCount: number,
    tagCount: number,
): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    let k = 0;
    for (let i = 0; i < postCount; i++) {
        out.push({
            id: id(IdKind.Tagging, k++),
            post: id(IdKind.Post, i),
            tag: id(IdKind.Tag, i % tagCount),
        });
        out.push({
            id: id(IdKind.Tagging, k++),
            post: id(IdKind.Post, i),
            tag: id(IdKind.Tag, (i + 1) % tagCount),
        });
    }
    return out;
}

/** Friendship chain `u0 - u1 - u2 - ... - u_{userCount-1}`. */
export function mkFriendChain(userCount: number): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < userCount - 1; i++) {
        out.push({
            id: id(IdKind.Friendship, i),
            userA: id(IdKind.User, i),
            userB: id(IdKind.User, i + 1),
        });
    }
    return out;
}

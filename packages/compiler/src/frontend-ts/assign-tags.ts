// assignTags — the pure pass that assigns each field a STABLE binary wire tag from the
// committed manifest (`keyma.tags.json`), so at-rest binary records survive schema evolution.
// Runs AFTER inheritance validation and name normalization, so it sees each class's final,
// prefixed, OWN field list. Inheritance is real, so it processes parents before children and
// reserves ancestor tags — a child's own-field tags continue past the chain's max, keeping the
// flat on-wire record's tag space globally unique. Mutates `field.tag` in place and consumes the
// frontend-transient `renamedFrom` hint; returns the next manifest (data only — the CLI persists).
//
// Per-class algorithm (priority order): manual @Tag pins → @RenamedFrom remaps → survivors
// (same name keeps its committed tag) → new fields (allocate `nextTag++`, monotonic, never
// reusing a tombstone). Removed names are tombstoned (their tag retired forever).
//
// Drift gate: a *simultaneous* add + remove in one class looks like an un-hinted rename
// (which would orphan stored data), so it is KEYMA100 unless `--accept-tags`. Pure additions
// and pure removals are additive and applied automatically.

import type { IRMember, IRClassDeclaration, IRDiagnostic, TagManifest, TagManifestSchema } from "@keyma/core/ir";
import { mkError } from "@keyma/core/util";
import { KEYMA100, KEYMA101, KEYMA103 } from "./diagnostics.js";

export const MAX_TAG = 2147483647;

/** An IRMember during the frontend passes — before the transient `renamedFrom` hint (from
 *  `@RenamedFrom`) is consumed and deleted by this pass. Never present in emitted IR. */
export type RawTaggedField = IRMember & { renamedFrom?: string };

export type AssignTagsResult = {
    manifest: TagManifest;
    diagnostics: IRDiagnostic[];
};

/** Strip the binary tag hints when binary serialization is disabled — guarantees `tag`/
 *  `renamedFrom` never leak into JSON-only IR (which `validateIR` would reject). */
export function stripTagHints(classes: IRClassDeclaration[]): void {
    for (const cls of classes) {
        for (const field of cls.fields as RawTaggedField[]) {
            if ("tag" in field) delete field.tag;
            if ("renamedFrom" in field) delete field.renamedFrom;
        }
    }
}

export function assignTags(
    prev: TagManifest | undefined,
    classes: IRClassDeclaration[],
    opts: { acceptTags: boolean },
): AssignTagsResult {
    const diagnostics: IRDiagnostic[] = [];
    const nextSchemas: Record<string, TagManifestSchema> = {};

    // Inheritance is real, so a child's binary record carries its parents' fields too. Process
    // parents before children and reserve every ancestor tag, so a child's own-field tags never
    // collide with an inherited one on the wire (they continue past the chain's max tag).
    const bySourceName = new Map(classes.map((s) => [s.sourceName, s]));
    const resultBySourceName = new Map<string, TagManifestSchema>();
    for (const cls of inheritanceOrder(classes, bySourceName)) {
        const reserved = new Set<number>();
        for (let p = ancestorOf(cls, bySourceName); p !== undefined; p = ancestorOf(p, bySourceName)) {
            const r = resultBySourceName.get(p.sourceName);
            if (r !== undefined) for (const t of Object.values(r.fields)) reserved.add(t);
        }
        const entry = assignClassTags(cls, prev?.schemas[cls.name], opts, diagnostics, reserved);
        nextSchemas[cls.name] = entry;
        resultBySourceName.set(cls.sourceName, entry);
    }

    // Carry forward manifest entries for classes no longer in the project (don't lose tag
    // history — stored records may still reference them). Class rename/removal is out of
    // scope for v1; preserving is the safe default.
    if (prev !== undefined) {
        for (const [name, entry] of Object.entries(prev.schemas)) {
            if (!(name in nextSchemas)) nextSchemas[name] = entry;
        }
    }

    return { manifest: { manifestVersion: "1", schemas: nextSchemas }, diagnostics };
}

/** Resolve a class's `extends` parent (sourceName) within the project, or undefined. */
function ancestorOf(
    cls: IRClassDeclaration,
    bySourceName: ReadonlyMap<string, IRClassDeclaration>,
): IRClassDeclaration | undefined {
    return cls.extends !== undefined ? bySourceName.get(cls.extends) : undefined;
}

/** Classes ordered so every parent precedes its children (a stable topo over `extends`). */
function inheritanceOrder(
    classes: IRClassDeclaration[],
    bySourceName: ReadonlyMap<string, IRClassDeclaration>,
): IRClassDeclaration[] {
    const ordered: IRClassDeclaration[] = [];
    const seen = new Set<string>();
    const visit = (s: IRClassDeclaration, path: Set<string>): void => {
        if (seen.has(s.sourceName) || path.has(s.sourceName)) return;
        path.add(s.sourceName);
        const parent = ancestorOf(s, bySourceName);
        if (parent !== undefined) visit(parent, path);
        path.delete(s.sourceName);
        if (!seen.has(s.sourceName)) { seen.add(s.sourceName); ordered.push(s); }
    };
    for (const s of classes) visit(s, new Set());
    return ordered;
}

function assignClassTags(
    cls: IRClassDeclaration,
    prevEntry: TagManifestSchema | undefined,
    opts: { acceptTags: boolean },
    diagnostics: IRDiagnostic[],
    reserved: ReadonlySet<number>,
): TagManifestSchema {
    const prevFields = prevEntry?.fields ?? {};
    // Seed past both the committed high-water mark and every inherited tag, so freshly-allocated
    // child tags continue after the ancestor chain's max (no on-wire collision).
    let nextTag = prevEntry?.nextTag ?? 1;
    for (const t of reserved) if (t + 1 > nextTag) nextTag = t + 1;

    const fields = cls.fields as RawTaggedField[];
    const newFields: Record<string, number> = {};
    const usedTags = new Set<number>();
    const tombstones = new Set<number>(prevEntry?.tombstones ?? []);
    const consumedOldNames = new Set<string>();
    const renamedNewNames = new Set<string>();

    const raise = (tag: number): void => {
        if (tag + 1 > nextTag) nextTag = tag + 1;
    };

    // Pass 1 — manual @Tag pins (already range-validated at extraction → KEYMA102). Assigned
    // first; the allocator routes around them. Duplicates / tombstone reuse → KEYMA103.
    const afterPins: RawTaggedField[] = [];
    for (const field of fields) {
        const pin = field.tag;
        if (pin === undefined) {
            afterPins.push(field);
            continue;
        }
        if (usedTags.has(pin) || tombstones.has(pin)) {
            diagnostics.push(mkError(KEYMA103,
                `Field "${field.name}" on schema "${cls.name}" pins @Tag(${pin}), which is already ${tombstones.has(pin) ? "tombstoned" : "used"} in this schema`,
                field.source));
        }
        usedTags.add(pin);
        newFields[field.name] = pin;
        delete field.renamedFrom;
        raise(pin);
    }

    // Pass 2 — @RenamedFrom remaps: carry the old name's committed tag onto the new field.
    const afterRenames: RawTaggedField[] = [];
    for (const field of afterPins) {
        const old = field.renamedFrom;
        if (old === undefined) {
            afterRenames.push(field);
            continue;
        }
        delete field.renamedFrom;
        const oldTag = prevFields[old];
        if (oldTag === undefined) {
            diagnostics.push(mkError(KEYMA101,
                `@RenamedFrom("${old}") on field "${field.name}" (schema "${cls.name}") names a field absent from the committed manifest`,
                field.source));
            afterRenames.push(field); // fall through → allocate a fresh tag
            continue;
        }
        if (usedTags.has(oldTag)) {
            diagnostics.push(mkError(KEYMA103,
                `Field "${field.name}" on schema "${cls.name}" renames from "${old}" (tag ${oldTag}), but that tag is already in use`,
                field.source));
        }
        usedTags.add(oldTag);
        newFields[field.name] = oldTag;
        field.tag = oldTag;
        consumedOldNames.add(old);
        renamedNewNames.add(field.name);
        raise(oldTag);
    }

    // Pass 3 — survivors keep their committed tag; Pass 4 — new fields allocate `nextTag++`.
    const newlyAllocated: RawTaggedField[] = [];
    for (const field of afterRenames) {
        const committed = prevFields[field.name];
        if (committed === undefined) {
            newlyAllocated.push(field);
            continue;
        }
        if (usedTags.has(committed)) {
            // A pin/rename stole this survivor's committed tag — a true tag change.
            diagnostics.push(mkError(KEYMA100,
                `Field "${field.name}" on schema "${cls.name}" would change its committed tag ${committed} (taken by a @Tag pin or @RenamedFrom). Re-run with --accept-tags or adjust the pin/rename.`,
                field.source));
            newlyAllocated.push(field);
            continue;
        }
        usedTags.add(committed);
        newFields[field.name] = committed;
        field.tag = committed;
    }
    for (const field of newlyAllocated) {
        let tag = nextTag++;
        while (usedTags.has(tag) || tombstones.has(tag) || reserved.has(tag)) tag = nextTag++;
        usedTags.add(tag);
        newFields[field.name] = tag;
        field.tag = tag;
    }

    // Tombstone removed fields (present in the manifest, gone from the class, not consumed
    // by a rename) — their tag is retired forever so a decoder always skips it.
    const removedNames: string[] = [];
    for (const [name, tag] of Object.entries(prevFields)) {
        if (name in newFields || consumedOldNames.has(name)) continue;
        removedNames.push(name);
        tombstones.add(tag);
    }
    // Genuinely-new names (excludes rename targets, which inherited a tag).
    const addedNames = Object.keys(newFields).filter((n) => !(n in prevFields) && !renamedNewNames.has(n));

    // Drift gate: a simultaneous add + remove looks like an un-hinted rename (which would
    // orphan stored binary data). Pure add or pure remove is additive and silent.
    if (!opts.acceptTags && removedNames.length > 0 && addedNames.length > 0) {
        diagnostics.push(mkError(KEYMA100,
            `Schema "${cls.name}" removed field(s) [${removedNames.join(", ")}] and added field(s) [${addedNames.join(", ")}] in one change — this looks like an un-hinted rename, which would orphan stored binary records. Add @RenamedFrom("<old>") to the renamed field(s), or re-run with --accept-tags to confirm an unrelated add+remove.`,
            cls.source));
    }

    return {
        nextTag,
        fields: newFields,
        tombstones: [...tombstones].sort((a, b) => a - b),
    };
}

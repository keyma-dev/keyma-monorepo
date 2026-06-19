import ts from "typescript";
import type { IRSourceLocation } from "@keyma/ir";
import { getLocation } from "./util.js";

export type EnumInfo = {
    name: string;
    /** Member name→value pairs, or null when the enum is not a portable string enum. */
    members: { name: string; value: string }[] | null;
    source: IRSourceLocation;
};

/**
 * Discover all TypeScript `enum` declarations in the program, keyed by name. A
 * portable enum has a string initializer on every member; non-portable enums
 * (numeric, computed, or heterogeneous) are recorded with `members: null` so the
 * type mapper can reject them where they are used (KEYMA025).
 */
export function discoverEnums(program: ts.Program): Map<string, EnumInfo> {
    const out = new Map<string, EnumInfo>();
    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        ts.forEachChild(sf, function visit(node) {
            if (ts.isEnumDeclaration(node)) {
                out.set(node.name.text, readEnum(node, sf));
            }
            ts.forEachChild(node, visit);
        });
    }
    return out;
}

function readEnum(node: ts.EnumDeclaration, sf: ts.SourceFile): EnumInfo {
    const name = node.name.text;
    const members: { name: string; value: string }[] = [];
    for (const m of node.members) {
        const mName = ts.isIdentifier(m.name) ? m.name.text
            : ts.isStringLiteral(m.name) ? m.name.text
            : undefined;
        if (mName === undefined || m.initializer === undefined || !ts.isStringLiteral(m.initializer)) {
            return { name, members: null, source: getLocation(node, sf) };
        }
        members.push({ name: mName, value: m.initializer.text });
    }
    return { name, members, source: getLocation(node, sf) };
}

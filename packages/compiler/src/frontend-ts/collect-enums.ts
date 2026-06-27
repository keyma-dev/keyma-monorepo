import type { IRClassDeclaration, IREnumDeclaration, IRType } from "@keyma/core/ir";
import type { EnumInfo } from "./discover-enums.js";

/**
 * The complete local enum surface: every project-local portable enum (referenced or not, so the
 * IR is a complete import surface), plus any referenced enum regardless of origin. A non-portable
 * enum (`members === null`) is skipped — it only errors where referenced (the type mapper reports
 * KEYMA025 there). Library enums ship as declaration files (already filtered by `discoverEnums`),
 * so a non-declaration source under `node_modules` is the only vendor case to exclude from the
 * eager pass; referenced vendor enums still come in via the use-driven pass below.
 */
export function collectLocalAndUsedEnums(
    classes: IRClassDeclaration[],
    enums: ReadonlyMap<string, EnumInfo>,
): IREnumDeclaration[] {
    const result: IREnumDeclaration[] = [];
    const added = new Set<string>();
    const push = (info: EnumInfo): void => {
        if (info.members == null || added.has(info.name)) return;
        added.add(info.name);
        result.push({ name: info.name, members: info.members, source: info.source });
    };

    // Eager: every project-local portable enum.
    for (const info of enums.values()) {
        if (!info.source.file.replace(/\\/g, "/").includes("/node_modules/")) push(info);
    }
    // Use-driven: any enum a field references (covers a vendor enum reached by reference).
    const used = new Set<string>();
    const visit = (t: IRType): void => {
        if (t.kind === "array") visit(t.of);
        else if (t.kind === "enum" && t.name !== undefined) used.add(t.name);
    };
    for (const cls of classes) {
        for (const field of cls.fields) visit(field.type);
    }
    for (const name of used) {
        const info = enums.get(name);
        if (info !== undefined) push(info);
    }
    return result;
}

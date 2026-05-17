import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { schemaTemplate } from "../templates.js";

export type GenOptions = {
    /** Schema name (used to derive class name + file name). */
    name: string;
    /** Project root. Defaults to cwd. */
    cwd?: string;
    /** When true, overwrite an existing file. */
    force?: boolean;
};

export function runGen(opts: GenOptions): { path: string } {
    const cwd = resolve(opts.cwd ?? process.cwd());
    const { relativePath, content } = schemaTemplate(opts.name);
    const abs = join(cwd, relativePath);

    if (existsSync(abs) && !opts.force) {
        throw new Error(`File "${abs}" already exists. Pass --force to overwrite.`);
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
    return { path: abs };
}

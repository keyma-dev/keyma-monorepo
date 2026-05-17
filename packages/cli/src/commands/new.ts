import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { projectFiles } from "../templates.js";

export type NewOptions = {
    /** Project name; also used as the directory name unless `dir` is given. */
    name: string;
    /** Target directory. Defaults to `<cwd>/<name>`. */
    dir?: string;
    /** When true, allow writing into a directory that already exists. */
    force?: boolean;
};

export function runNew(opts: NewOptions): { dir: string; files: string[] } {
    const dir = resolve(opts.dir ?? join(process.cwd(), opts.name));
    const projectName = basename(dir) === opts.name ? opts.name : opts.name;

    if (existsSync(dir) && !opts.force) {
        const entries = readdirSync(dir);
        if (entries.length > 0) {
            throw new Error(`Refusing to scaffold into non-empty directory "${dir}". Pass --force to override.`);
        }
    }
    mkdirSync(dir, { recursive: true });

    const written: string[] = [];
    for (const file of projectFiles(projectName)) {
        const abs = join(dir, file.relativePath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, file.content, "utf-8");
        written.push(abs);
    }
    return { dir, files: written };
}

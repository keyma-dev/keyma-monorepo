#!/usr/bin/env node
import { runNew, type NewOptions } from "./commands/new.js";
import { runGen, type GenOptions } from "./commands/gen.js";
import { runBuild, type BuildOptions } from "./commands/build.js";
import { runInspect, type InspectOptions } from "./commands/inspect.js";
import { runWatch, type WatchOptions } from "./commands/watch.js";
import { printDiagnostics } from "./diagnostics.js";

const USAGE = `keyma — declarative schema compiler

Usage:
  keyma new <name>          Scaffold a new project in ./<name>
  keyma gen <schema>        Generate a schema file under src/
  keyma build               Run the compiler pipeline
  keyma watch               Watch sources and rebuild on change
  keyma inspect [--out F]   Print (or write) the IR for the current project

Options:
  --help, -h                Show this help
  --force                   Overwrite existing files (new, gen)
`;

async function main(argv: readonly string[]): Promise<number> {
    const [command, ...rest] = argv;
    if (command === undefined || command === "--help" || command === "-h" || command === "help") {
        process.stdout.write(USAGE);
        return 0;
    }

    const flags = parseFlags(rest);

    switch (command) {
        case "new": {
            const name = flags.positional[0];
            if (name === undefined) {
                process.stderr.write("error: `keyma new` requires a project name.\n");
                return 1;
            }
            const opts: NewOptions = { name };
            if (flags.boolean.force) opts.force = true;
            const { dir, files } = runNew(opts);
            process.stdout.write(`Created project at ${dir}\n`);
            for (const f of files) process.stdout.write(`  ${f}\n`);
            return 0;
        }
        case "gen": {
            const name = flags.positional[0];
            if (name === undefined) {
                process.stderr.write("error: `keyma gen` requires a schema name.\n");
                return 1;
            }
            const opts: GenOptions = { name };
            if (flags.boolean.force) opts.force = true;
            const { path } = runGen(opts);
            process.stdout.write(`Created ${path}\n`);
            return 0;
        }
        case "build": {
            const opts: BuildOptions = {};
            if (flags.string.config !== undefined) opts.configPath = flags.string.config;
            const result = await runBuild(opts);
            printDiagnostics(result.diagnostics);
            if (result.hasErrors) return 1;
            //for (const f of result.written) process.stdout.write(`wrote ${f}\n`);
            return 0;
        }
        case "watch": {
            const opts: WatchOptions = {};
            if (flags.string.config !== undefined) opts.configPath = flags.string.config;
            const handle = await runWatch(opts);
            const shutdown = async (): Promise<void> => {
                await handle.close();
                process.exit(0);
            };
            process.on("SIGINT", () => { void shutdown(); });
            process.on("SIGTERM", () => { void shutdown(); });
            // Keep the process alive; the watch handle owns the watchers.
            return await new Promise<number>(() => { /* never resolves */ });
        }
        case "inspect": {
            const opts: InspectOptions = {};
            if (flags.string.config !== undefined) opts.configPath = flags.string.config;
            if (flags.string.out !== undefined) opts.outFile = flags.string.out;
            const result = await runInspect(opts);
            printDiagnostics(result.diagnostics);
            if (result.hasErrors) return 1;
            if (result.outFile !== undefined) {
                process.stdout.write(`wrote ${result.outFile}\n`);
            } else {
                process.stdout.write(JSON.stringify(result.ir, null, 2) + "\n");
            }
            return 0;
        }
        default: {
            process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
            return 1;
        }
    }
}

type ParsedFlags = {
    positional: string[];
    boolean: { force?: boolean };
    string: { config?: string; out?: string };
};

function parseFlags(argv: readonly string[]): ParsedFlags {
    const out: ParsedFlags = { positional: [], boolean: {}, string: {} };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === "--force") {
            out.boolean.force = true;
        } else if (arg === "--config") {
            const v = argv[++i];
            if (v !== undefined) out.string.config = v;
        } else if (arg.startsWith("--config=")) {
            out.string.config = arg.slice("--config=".length);
        } else if (arg === "--out") {
            const v = argv[++i];
            if (v !== undefined) out.string.out = v;
        } else if (arg.startsWith("--out=")) {
            out.string.out = arg.slice("--out=".length);
        } else {
            out.positional.push(arg);
        }
    }
    return out;
}

main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`error: ${message}\n`);
        process.exit(1);
    }
);

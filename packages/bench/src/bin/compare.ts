import { printComparison } from "../compare.js";
import { readResult } from "../report.js";

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length !== 2) {
        console.error("usage: compare <a.json> <b.json>");
        process.exit(2);
    }
    const a = await readResult(args[0]!);
    const b = await readResult(args[1]!);
    printComparison(a, b);
}

await main();

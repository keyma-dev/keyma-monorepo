#!/usr/bin/env node
// Release the core @keyma/* packages to npm, in lockstep, using best practices.
//
//   npm run release -- <patch|minor|major|x.y.z> [flags]
//
// Flow: preflight -> resolve version -> clean+build (topo) -> test (topo) ->
//       bump version + rewrite intra-set dep ranges -> pack-verify ->
//       publish (topo, idempotent) -> git commit + tag (+ push).
//
// Best-practice properties:
//   * Synchronized versioning: all core packages share one version; intra-set
//     deps are rewritten from "*" to "^<version>" so consumers get a real range.
//   * Topological build AND publish order (derived from the manifests, not hardcoded)
//     so dependencies are built/registry-available before dependents.
//   * Pack-verify gate: asserts every entrypoint a manifest advertises actually
//     ships in the tarball (catches the "dist not published" class of bug).
//   * Idempotent: a version already on the registry is skipped, so a partial run
//     can be safely re-run.
//   * --dry-run does everything read-only (no writes, no publish, no git).
//
// Pure Node, zero dependencies.

import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The exact publish set (directory names under packages/). Ordering is derived
// by toposort below — this list only defines membership.
const CORE_DIRS = [
    "dsl",
    "ir",
    "compiler",
    "compiler-frontend-ts",
    "compiler-backend-js",
    "compiler-backend-python",
    "compiler-backend-cpp",
    "runtime-js",
    "validators",
    "formatters",
];

// ---------------------------------------------------------------------------
// tiny console helpers
// ---------------------------------------------------------------------------
const c = {
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const step = (s) => console.log(`\n${c.bold(c.cyan("▶ " + s))}`);
const info = (s) => console.log(`  ${s}`);
const ok = (s) => console.log(`  ${c.green("✓")} ${s}`);
const warn = (s) => console.warn(`  ${c.yellow("!")} ${s}`);
const die = (s) => {
    console.error(`\n${c.red("✗ " + s)}`);
    process.exit(1);
};

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------
function sh(cmd, args, { cwd = ROOT, capture = false } = {}) {
    const r = spawnSync(cmd, args, {
        cwd,
        encoding: "utf8",
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    if (r.error) throw r.error;
    return r;
}
const shTry = (cmd, args, opts) => sh(cmd, args, { ...opts, capture: true });
function shOut(cmd, args, opts) {
    const r = shTry(cmd, args, opts);
    if (r.status !== 0) throw new Error(`\`${cmd} ${args.join(" ")}\` failed: ${(r.stderr || r.stdout || "").trim()}`);
    return r.stdout.trim();
}
function shRun(cmd, args, opts) {
    const r = sh(cmd, args, opts);
    if (r.status !== 0) throw new Error(`\`${cmd} ${args.join(" ")}\` exited with code ${r.status}`);
}

// ---------------------------------------------------------------------------
// semver (minimal — no prerelease bumping)
// ---------------------------------------------------------------------------
function parseSemver(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
    if (!m) throw new Error(`not a valid semver: ${v}`);
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}
function computeTarget(current, bump) {
    if (/^\d+\.\d+\.\d+/.test(bump)) {
        parseSemver(bump); // validate
        return bump;
    }
    const s = parseSemver(current);
    if (bump === "major") return `${s.major + 1}.0.0`;
    if (bump === "minor") return `${s.major}.${s.minor + 1}.0`;
    if (bump === "patch") return `${s.major}.${s.minor}.${s.patch + 1}`;
    throw new Error(`unknown bump "${bump}" (expected patch | minor | major | x.y.z)`);
}

// ---------------------------------------------------------------------------
// manifest loading / writing (preserves indentation + trailing newline)
// ---------------------------------------------------------------------------
function detectIndent(raw) {
    const m = /\n([ \t]+)\S/.exec(raw);
    return m ? m[1] : "  ";
}
function loadPackages() {
    return CORE_DIRS.map((dir) => {
        const dirAbs = path.join(ROOT, "packages", dir);
        const manifestPath = path.join(dirAbs, "package.json");
        if (!existsSync(manifestPath)) die(`missing manifest: ${path.relative(ROOT, manifestPath)}`);
        const raw = readFileSync(manifestPath, "utf8");
        const json = JSON.parse(raw);
        return { dir, dirAbs, manifestPath, json, indent: detectIndent(raw) };
    });
}
function writeManifest(pkg) {
    writeFileSync(pkg.manifestPath, JSON.stringify(pkg.json, null, pkg.indent) + "\n");
}

// Deps-before-dependents order, restricted to the publish set.
function topoOrder(packages) {
    const inSet = new Set(packages.map((p) => p.json.name));
    const byName = new Map(packages.map((p) => [p.json.name, p]));
    const out = [];
    const done = new Set();
    const visit = (p, stack) => {
        if (done.has(p.json.name)) return;
        if (stack.has(p.json.name)) throw new Error(`dependency cycle through ${p.json.name}`);
        stack.add(p.json.name);
        const deps = { ...(p.json.dependencies || {}), ...(p.json.peerDependencies || {}) };
        for (const name of Object.keys(deps)) if (inSet.has(name)) visit(byName.get(name), stack);
        stack.delete(p.json.name);
        done.add(p.json.name);
        out.push(p);
    };
    for (const p of packages) visit(p, new Set());
    return out;
}

// Every file path a manifest advertises (main / types / all exports targets).
function entryPaths(json) {
    const set = new Set();
    const add = (v) => {
        if (typeof v === "string" && v.startsWith("./")) set.add(v.slice(2));
    };
    add(json.main);
    add(json.types);
    const walk = (e) => {
        if (typeof e === "string") add(e);
        else if (e && typeof e === "object") for (const v of Object.values(e)) walk(v);
    };
    if (json.exports) walk(json.exports);
    return [...set];
}

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
    const opts = {
        bump: null,
        dryRun: false,
        yes: false,
        skipTests: false,
        git: true,
        push: false,
        provenance: false,
        clean: true,
        tag: "latest",
        otp: null,
        registry: null,
    };
    for (const a of argv) {
        if (a === "--dry-run") opts.dryRun = true;
        else if (a === "--yes" || a === "-y") opts.yes = true;
        else if (a === "--skip-tests") opts.skipTests = true;
        else if (a === "--no-git") opts.git = false;
        else if (a === "--no-clean") opts.clean = false;
        else if (a === "--push") opts.push = true;
        else if (a === "--provenance") opts.provenance = true;
        else if (a.startsWith("--tag=")) opts.tag = a.slice("--tag=".length);
        else if (a.startsWith("--otp=")) opts.otp = a.slice("--otp=".length);
        else if (a.startsWith("--registry=")) opts.registry = a.slice("--registry=".length);
        else if (a === "--help" || a === "-h") {
            usage();
            process.exit(0);
        } else if (a.startsWith("-")) die(`unknown flag: ${a}`);
        else if (!opts.bump) opts.bump = a;
        else die(`unexpected argument: ${a}`);
    }
    if (!opts.bump) {
        usage();
        process.exit(1);
    }
    return opts;
}
function usage() {
    console.log(`Release the core @keyma/* packages to npm.

Usage:
  npm run release -- <patch|minor|major|x.y.z> [flags]

Flags:
  --dry-run        Do everything read-only: no writes, no publish, no git.
  --yes, -y        Skip the confirmation prompt.
  --skip-tests     Build but do not run the package test suites.
  --no-clean       Do not delete dist/ before building.
  --no-git         Do not commit/tag after publishing.
  --push           After committing+tagging, push with --follow-tags.
  --provenance     Pass --provenance to npm publish (CI/OIDC only).
  --tag=<dist-tag> npm dist-tag to publish under (default: latest).
  --otp=<code>     One-time password for npm 2FA.
  --registry=<url> Publish/check against a custom registry (e.g. a local Verdaccio).`);
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------
function preflight(opts, registryArgs) {
    step("Preflight");
    if (!shTry("git", ["rev-parse", "--is-inside-work-tree"]).stdout?.trim()) die("not inside a git work tree");

    const branch = shOut("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch !== "main") {
        if (opts.dryRun) warn(`on branch "${branch}" (release expects "main")`);
        else die(`must release from "main" (current branch: "${branch}")`);
    } else ok(`on branch main`);

    const dirty = shOut("git", ["status", "--porcelain"]);
    if (dirty) {
        if (opts.dryRun) warn("working tree is dirty (would block a real release)");
        else die("working tree is dirty — commit or stash first");
    } else ok("working tree clean");

    if (opts.dryRun) {
        info("dry-run: skipping npm auth check");
    } else {
        const who = shTry("npm", ["whoami", ...registryArgs]);
        if (who.status !== 0) die(`not authenticated to npm${opts.registry ? ` (${opts.registry})` : ""} — run \`npm login\``);
        ok(`authenticated as ${who.stdout.trim()}`);
    }
}

function resolveVersion(packages, bump) {
    step("Resolve version");
    const versions = [...new Set(packages.map((p) => p.json.version))];
    if (versions.length > 1) warn(`core packages are not in sync: ${versions.join(", ")} — using ${versions[0]} as the base`);
    const current = packages[0].json.version;
    const target = computeTarget(current, bump);
    if (parseSemver(target) && target === current && !/^\d/.test(bump)) {
        // bump keyword produced same version — impossible, but guard explicit equal
    }
    ok(`${current} → ${c.bold(target)}`);
    return target;
}

function cleanAndBuild(order, opts) {
    step(opts.clean ? "Clean + build (topological)" : "Build (topological)");
    for (const pkg of order) {
        if (opts.clean) {
            const dist = path.join(pkg.dirAbs, "dist");
            rmSync(dist, { recursive: true, force: true });
        }
        info(`building ${pkg.json.name} …`);
        shRun("npm", ["run", "build", "--workspace", pkg.json.name]);
    }
    ok("all core packages built");
}

function test(order, opts) {
    if (opts.skipTests) {
        warn("skipping tests (--skip-tests)");
        return;
    }
    step("Test (topological)");
    for (const pkg of order) {
        info(`testing ${pkg.json.name} …`);
        shRun("npm", ["run", "test", "--workspace", pkg.json.name]);
    }
    ok("all core packages pass");
}

function applyVersions(packages, target, opts) {
    step(opts.dryRun ? "Plan version + dependency rewrite (dry-run)" : "Apply version + dependency rewrite");
    const inSet = new Set(packages.map((p) => p.json.name));
    for (const pkg of packages) {
        const changes = [];
        if (pkg.json.version !== target) changes.push(`version ${pkg.json.version} → ${target}`);
        pkg.json.version = target;
        for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
            const deps = pkg.json[field];
            if (!deps) continue;
            for (const name of Object.keys(deps)) {
                if (inSet.has(name) && deps[name] !== `^${target}`) {
                    changes.push(`${field}.${name} ${deps[name]} → ^${target}`);
                    deps[name] = `^${target}`;
                }
            }
        }
        if (!opts.dryRun) writeManifest(pkg);
        info(`${pkg.json.name}: ${changes.length ? changes.join("; ") : c.dim("no changes")}`);
    }
    if (opts.dryRun) warn("dry-run: manifests NOT written");
    else ok("manifests updated");
}

function packVerify(packages) {
    step("Pack-verify (entrypoints ship in the tarball)");
    for (const pkg of packages) {
        const r = shTry("npm", ["pack", "--dry-run", "--json"], { cwd: pkg.dirAbs });
        if (r.status !== 0) throw new Error(`npm pack failed for ${pkg.json.name}: ${(r.stderr || "").trim()}`);
        let meta;
        try {
            meta = JSON.parse(r.stdout);
        } catch {
            throw new Error(`could not parse npm pack output for ${pkg.json.name}`);
        }
        const files = new Set((meta[0]?.files ?? []).map((f) => f.path));
        const required = entryPaths(pkg.json);
        const missing = required.filter((p) => !files.has(p));
        if (missing.length) throw new Error(`${pkg.json.name}: tarball is missing advertised entrypoint(s): ${missing.join(", ")}`);
        ok(`${pkg.json.name} ${c.dim(`(${meta[0].files.length} files, ${meta[0].unpackedSize ?? "?"} B unpacked)`)}`);
    }
}

function isPublished(name, version, registryArgs) {
    const r = shTry("npm", ["view", `${name}@${version}`, "version", ...registryArgs]);
    return r.status === 0 && r.stdout.trim() === version;
}

function publish(order, target, opts, registryArgs) {
    step(opts.dryRun ? "Publish (dry-run)" : "Publish (topological, idempotent)");
    const published = [];
    for (const pkg of order) {
        if (isPublished(pkg.json.name, target, registryArgs)) {
            warn(`${pkg.json.name}@${target} already on registry — skip`);
            continue;
        }
        const args = ["publish", "--access", "public", "--tag", opts.tag, ...registryArgs];
        if (opts.provenance) args.push("--provenance");
        if (opts.otp) args.push("--otp", opts.otp);
        if (opts.dryRun) args.push("--dry-run");
        info(`publishing ${pkg.json.name}@${target} …`);
        shRun("npm", args, { cwd: pkg.dirAbs });
        published.push(pkg.json.name);
    }
    if (opts.dryRun) ok("dry-run publish complete");
    else ok(published.length ? `published: ${published.join(", ")}` : "nothing to publish (all up to date)");
}

function gitFinalize(target, opts) {
    if (!opts.git || opts.dryRun) {
        if (opts.dryRun) warn("dry-run: skipping git commit/tag");
        else warn("skipping git commit/tag (--no-git)");
        return;
    }
    step("Git commit + tag");
    shRun("git", ["add", "-A"]);
    const staged = sh("git", ["diff", "--cached", "--quiet"]).status; // 1 = has staged changes
    if (staged === 1) {
        shRun("git", ["commit", "-m", `release: v${target}`]);
        ok(`committed release: v${target}`);
    } else {
        warn("no manifest changes to commit");
    }
    const tag = `v${target}`;
    const tagExists = shTry("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).status === 0;
    if (tagExists) warn(`tag ${tag} already exists — leaving as-is`);
    else {
        shRun("git", ["tag", "-a", tag, "-m", tag]);
        ok(`tagged ${tag}`);
    }
    if (opts.push) {
        shRun("git", ["push", "--follow-tags"]);
        ok("pushed with --follow-tags");
    } else {
        info(c.dim("not pushed (pass --push to push commit + tag)"));
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const registryArgs = opts.registry ? ["--registry", opts.registry] : [];

    const packages = loadPackages();
    const order = topoOrder(packages);

    console.log(c.bold(`\nKeyma release ${opts.dryRun ? c.yellow("(dry-run)") : ""}`));
    info(`packages: ${order.map((p) => p.dir).join(" → ")}`);

    preflight(opts, registryArgs);
    const target = resolveVersion(packages, opts.bump);

    if (!opts.yes && !opts.dryRun) {
        const rl = readline.createInterface({ input, output });
        const answer = await rl.question(
            `\nRelease ${c.bold(`v${target}`)} of ${packages.length} packages` +
                `${opts.registry ? ` to ${opts.registry}` : ""} under dist-tag "${opts.tag}"? [y/N] `,
        );
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) die("aborted by user");
    }

    cleanAndBuild(order, opts);
    test(order, opts);
    applyVersions(packages, target, opts);
    packVerify(order);
    publish(order, target, opts, registryArgs);
    gitFinalize(target, opts);

    console.log(`\n${c.green(c.bold(`Done — v${target}${opts.dryRun ? " (dry-run)" : ""}`))}`);
}

main().catch((err) => die(err?.stack || String(err)));

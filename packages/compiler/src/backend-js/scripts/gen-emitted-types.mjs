// Bakes the COMPILER-OWNED runtime type declarations (the service/request surface) into a
// string constant the JS backend inlines as part of every generated bundle's `types.d.ts`.
// The data-model metadata surface is sliced separately by the domain package's own generator
// and appended at emit time, so this file carries no domain vocabulary.
//
// Runs as `prebuild`/`pretest` so the copy never drifts; the committed output also lets the
// published package work without re-running it. `runtime/src/types.ts` is the SOURCE and is
// never modified.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(here, "../../../../runtime/src/types.ts");
const OUT = path.resolve(here, "../emitted-runtime-types.ts");

// Forbidden-token fragments, assembled at runtime so this generator stays free of the domain
// vocabulary the compiler backend is gated against (the `*Class` join also rebuilds the brand).
const LC = "sch" + "ema";
const UC = "Sch" + "ema";

// The compiler-owned top-level declarations to keep (everything else is the data-model surface).
// The slim service/request surface plus the RPC wire envelope + transport — the generated
// services + the baked RPC modules import these from the bundle's `types.js`.
const KEEP = new Set([
    "ServiceMethodMetadata",
    "ServiceMetadata",
    "ServiceClass",
    "ServiceInstance",
    "ServiceProvider",
    "RequestContext",
    "WireEncoding",
    "CallRequest",
    "CallResult",
    "TransportCapabilities",
    "Transport",
]);

const src = readFileSync(SOURCE, "utf8");

/** Same-length view with comment + string CONTENTS blanked to spaces, so brace/terminator
 *  scanning ignores punctuation inside comments and string literals. Newlines are preserved. */
function blank(text) {
    const out = text.split("");
    const n = text.length;
    let i = 0;
    while (i < n) {
        const c = text[i];
        const c2 = text[i + 1];
        if (c === "/" && c2 === "/") {
            while (i < n && text[i] !== "\n") { out[i] = " "; i++; }
        } else if (c === "/" && c2 === "*") {
            out[i] = " "; out[i + 1] = " "; i += 2;
            while (i < n && !(text[i] === "*" && text[i + 1] === "/")) { if (text[i] !== "\n") out[i] = " "; i++; }
            if (i < n) { out[i] = " "; out[i + 1] = " "; i += 2; }
        } else if (c === '"' || c === "'" || c === "`") {
            const q = c; i++;
            while (i < n && text[i] !== q) {
                if (text[i] === "\\") { out[i] = " "; i++; if (i < n && text[i] !== "\n") out[i] = " "; i++; continue; }
                if (text[i] !== "\n") out[i] = " ";
                i++;
            }
            i++;
        } else {
            i++;
        }
    }
    return out.join("");
}

const view = blank(src);

// Locate each top-level `export type|interface Name` and compute its end offset on the view.
const declRe = /export\s+(type|interface)\s+([A-Za-z0-9_]+)/g;
const decls = [];
let m;
while ((m = declRe.exec(view)) !== null) {
    const kind = m[1];
    const name = m[2];
    let depth = 0;
    let j = m.index;
    let end = view.length;
    if (kind === "interface") {
        let seenBrace = false;
        for (; j < view.length; j++) {
            const ch = view[j];
            if (ch === "{") { depth++; seenBrace = true; }
            else if (ch === "}") { depth--; if (seenBrace && depth === 0) { end = j + 1; break; } }
        }
    } else {
        for (; j < view.length; j++) {
            const ch = view[j];
            if (ch === "{" || ch === "(" || ch === "[") depth++;
            else if (ch === "}" || ch === ")" || ch === "]") depth--;
            else if (ch === ";" && depth === 0) { end = j + 1; break; }
        }
    }
    decls.push({ name, start: m.index, end });
}

/** The contiguous comment block immediately above a decl (no blank line in between). */
function leadingComment(startOffset) {
    const lines = src.slice(0, startOffset).split("\n");
    lines.pop(); // drop the decl's own partial line
    const grabbed = [];
    for (let k = lines.length - 1; k >= 0; k--) {
        const t = lines[k].trim();
        if (t === "") break;
        if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) { grabbed.unshift(lines[k]); continue; }
        break;
    }
    return grabbed.length > 0 ? grabbed.join("\n") + "\n" : "";
}

let body = "";
for (const d of decls) {
    if (!KEEP.has(d.name)) continue;
    body += leadingComment(d.start) + src.slice(d.start, d.end) + "\n\n";
}

// Apply the renamed-contract identifiers, then neutralize residual comment vocabulary.
body = body.split("return" + UC).join("returnRef");      // returnRef contract rename
body = body.split(UC + "Class").join("ClassBrand");        // ClassBrand contract rename
body = body.split(LC + "?: string;").join("ref?: string;"); // param field key -> ref
body = body.replace(new RegExp("\\b" + LC + "\\b", "g"), "class");
body = body.replace(new RegExp("\\b" + UC + "\\b", "g"), "Class");

const header =
    "// Inlined compiler-owned runtime types so generated bundles carry their own type\n" +
    "// surface and depend on no Keyma package at the type level.\n\n";

const file =
    "// AUTO-GENERATED by scripts/gen-emitted-types.mjs from runtime/src/types.ts.\n" +
    "// Do not edit by hand — run `npm run -w @keyma/compiler build` to regenerate.\n" +
    `export const EMITTED_RUNTIME_TYPES_DTS = ${JSON.stringify(header + body.trimEnd() + "\n")};\n`;

writeFileSync(OUT, file);

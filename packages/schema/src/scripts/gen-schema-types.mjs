// Bakes the data-model metadata type declarations (the `ClassMetadata` surface) into a string
// constant the schema domain ships as `KeymaDomain.runtimeTypeDecls`. The JS backend appends it
// to every generated bundle's `types.d.ts`, alongside the compiler-owned service/request blob.
// Mirrors the compiler's `gen-emitted-types.mjs` pattern.
//
// Runs as `prebuild`/`pretest` so the copy never drifts. `runtime/src/types.ts` is the SOURCE
// and is never modified (deferred to the runtime rewrite); this slices + renames it.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(here, "../../../runtime/src/types.ts");
const OUT = path.resolve(here, "../emitted-runtime-types.ts");

// The data-model metadata declarations to keep (the service/request surface is sliced by the
// compiler's own generator instead).
const KEEP = new Set([
    "FieldType",
    "ValidatorContext",
    "FormatterContext",
    "ValidatorFn",
    "FormatterFn",
    "FormatterEntry",
    "SchemaDefaultsFn",
    "FieldIndex",
    "SchemaIndex",
    "FieldDefault",
    "FormFieldMeta",
    "FieldMetadata",
    "EdgeMetadata",
    "SchemaMetadata",
    "ValidationError",
    "SchemaClass",
    "RecordOf",
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

const declRe = /export\s+(type|interface)\s+([A-Za-z0-9_]+)/g;
const decls = [];
let m;
while ((m = declRe.exec(view)) !== null) {
    const kind = m[1];
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
    decls.push({ name: m[2], start: m.index, end });
}

/** The contiguous comment block immediately above a decl (no blank line in between). */
function leadingComment(startOffset) {
    const lines = src.slice(0, startOffset).split("\n");
    lines.pop();
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

// Apply the renamed cross-language contract (decision #2 / CONTRACT §2 + §5). The Field*/Edge*/
// Validator*/Formatter*/ValidationError/RecordOf type names are kept; only the Schema* names and
// the emitted member keys change.
body = body.split("SchemaMetadata").join("ClassMetadata");
body = body.split("SchemaDefaultsFn").join("ClassDefaultsFn");
body = body.split("SchemaIndex").join("ClassIndex");
body = body.split("SchemaClass").join("ClassBrand");
// The ClassBrand brand carries its metadata under `.metadata` (was `.schema`).
body = body.split("readonly schema:").join("readonly metadata:");
// FieldType reference/embedded carry the target class identity under `target` (core IRType rename).
body = body.split('"reference"; schema:').join('"reference"; target:');
body = body.split('"embedded"; schema:').join('"embedded"; target:');

const header =
    "// Data-model metadata types — the `ClassMetadata` surface a generated bundle carries.\n" +
    "// Concatenated after the compiler-owned service/request blob in each bundle's types.d.ts.\n\n";

const file =
    "// AUTO-GENERATED by scripts/gen-schema-types.mjs from runtime/src/types.ts.\n" +
    "// Do not edit by hand — run `npm run -w @keyma/schema build` to regenerate.\n" +
    `export const EMITTED_SCHEMA_TYPES_DTS = ${JSON.stringify(header + body.trimEnd() + "\n")};\n`;

writeFileSync(OUT, file);

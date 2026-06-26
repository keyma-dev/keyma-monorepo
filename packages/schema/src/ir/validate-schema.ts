// The schema-domain IR section checks. Moved out of `@keyma/core/ir` so the core IR
// stays domain-neutral; these build on the generic IR-node validators exported by
// `@keyma/core/ir` (checkType/checkExpression/checkStatement/checkSourceLocation + the
// type guards and `e`). `schemaIRValidator` is registered onto the core
// `IRValidatorRegistry` by the CLI; for a valid IR document it produces zero errors, so
// registration order relative to the envelope checks has no observable effect.
import {
    e,
    isObj,
    isStr,
    isNum,
    isBool,
    isArr,
    checkType,
    checkExpression,
    checkStatement,
    checkSourceLocation,
    type IRValidationError,
    type IRDocumentValidator,
} from "@keyma/core/ir";
import { SCHEMA_EXT, UI_EXT } from "./extensions.js";

/**
 * Schema-domain IR sections — classes, enums, function declarations (utilities + the
 * collapsed validator/formatter factories), and services. Validator/formatter field
 * attachments ride in `field.extensions['schema']`. Registered onto the IR validator
 * registry by the CLI; the core envelope checks stay in `@keyma/core/ir`.
 */
export function checkSchemaDomain(doc: Record<string, unknown>): IRValidationError[] {
    const errors: IRValidationError[] = [];

    if (!isArr(doc["classes"])) {
        errors.push(e("classes", "must be an array"));
    } else {
        doc["classes"].forEach((s, i) => errors.push(...checkSchema(s, `classes[${i}]`)));
    }

    if ("enums" in doc && doc["enums"] !== undefined) {
        if (!isArr(doc["enums"])) {
            errors.push(e("enums", "must be an array when present"));
        } else {
            doc["enums"].forEach((d, i) => errors.push(...checkEnumDeclaration(d, `enums[${i}]`)));
        }
    }

    if ("functionDeclarations" in doc && doc["functionDeclarations"] !== undefined) {
        if (!isArr(doc["functionDeclarations"])) {
            errors.push(e("functionDeclarations", "must be an array when present"));
        } else {
            doc["functionDeclarations"].forEach((d, i) =>
                errors.push(...checkFunctionDeclaration(d, `functionDeclarations[${i}]`)));
        }
    }

    if ("services" in doc && doc["services"] !== undefined) {
        if (!isArr(doc["services"])) {
            errors.push(e("services", "must be an array when present"));
        } else {
            doc["services"].forEach((s, i) => errors.push(...checkService(s, `services[${i}]`)));
        }
    }

    return errors;
}

/** The schema-domain IR validator, registered onto the core `IRValidatorRegistry` by the CLI. */
export const schemaIRValidator: IRDocumentValidator = checkSchemaDomain;

/** Shared check for a `{ name, type, optional? }` typed parameter. */
function checkParam(p: unknown, path: string): IRValidationError[] {
    if (!isObj(p)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    if (!isStr(p["name"]) || p["name"] === "") errors.push(e(`${path}.name`, "must be a non-empty string"));
    errors.push(...checkType(p["type"], `${path}.type`));
    if ("optional" in p && p["optional"] !== undefined && !isBool(p["optional"])) {
        errors.push(e(`${path}.optional`, "must be a boolean when present"));
    }
    return errors;
}

function checkService(svc: unknown, path: string): IRValidationError[] {
    if (!isObj(svc)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    if (!isStr(svc["id"]) || svc["id"] === "") errors.push(e(`${path}.id`, "must be a non-empty string"));
    if (!isStr(svc["name"]) || svc["name"] === "") errors.push(e(`${path}.name`, "must be a non-empty string"));
    if (!isStr(svc["sourceName"]) || svc["sourceName"] === "") errors.push(e(`${path}.sourceName`, "must be a non-empty string"));
    if (svc["visibility"] !== "public" && svc["visibility"] !== "private") {
        errors.push(e(`${path}.visibility`, 'must be "public" or "private"'));
    }
    if ("description" in svc && svc["description"] !== undefined && !isStr(svc["description"])) {
        errors.push(e(`${path}.description`, "must be a string when present"));
    }
    if (!isArr(svc["methods"])) {
        errors.push(e(`${path}.methods`, "must be an array"));
    } else {
        svc["methods"].forEach((m, i) => errors.push(...checkServiceMethod(m, `${path}.methods[${i}]`)));
    }
    errors.push(...checkSourceLocation(svc["source"], `${path}.source`));
    return errors;
}

function checkServiceMethod(m: unknown, path: string): IRValidationError[] {
    if (!isObj(m)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    if (!isStr(m["name"]) || m["name"] === "") errors.push(e(`${path}.name`, "must be a non-empty string"));
    if (!isArr(m["params"])) {
        errors.push(e(`${path}.params`, "must be an array"));
    } else {
        m["params"].forEach((p, i) => errors.push(...checkParam(p, `${path}.params[${i}]`)));
    }
    if ("returnType" in m && m["returnType"] !== undefined) {
        errors.push(...checkType(m["returnType"], `${path}.returnType`));
    }
    if (m["visibility"] !== "public" && m["visibility"] !== "private") {
        errors.push(e(`${path}.visibility`, 'must be "public" or "private"'));
    }
    errors.push(...checkSourceLocation(m["source"], `${path}.source`));
    return errors;
}

function checkSchema(schema: unknown, path: string): IRValidationError[] {
    if (!isObj(schema)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];

    if (!isStr(schema["name"]) || schema["name"] === "") errors.push(e(`${path}.name`, "must be a non-empty string"));
    if (!isStr(schema["sourceName"]) || schema["sourceName"] === "") errors.push(e(`${path}.sourceName`, "must be a non-empty string"));
    if (schema["visibility"] !== "public" && schema["visibility"] !== "private") {
        errors.push(e(`${path}.visibility`, 'must be "public" or "private"'));
    }
    if ("description" in schema && schema["description"] !== undefined && !isStr(schema["description"])) {
        errors.push(e(`${path}.description`, "must be a string when present"));
    }
    if ("extends" in schema && schema["extends"] !== undefined && !isStr(schema["extends"])) {
        errors.push(e(`${path}.extends`, "must be a string when present"));
    }
    if ("extendsSource" in schema && schema["extendsSource"] !== undefined && !isStr(schema["extendsSource"])) {
        errors.push(e(`${path}.extendsSource`, "must be a string when present"));
    }

    if (!isArr(schema["fields"])) {
        errors.push(e(`${path}.fields`, "must be an array"));
    } else {
        schema["fields"].forEach((f, i) => errors.push(...checkField(f, `${path}.fields[${i}]`)));
        // Binary wire tags must be unique within a schema (decode keys by tag).
        const seenTags = new Map<number, number>();
        schema["fields"].forEach((f, i) => {
            if (!isObj(f)) return;
            const t = f["tag"];
            if (isNum(t) && Number.isInteger(t)) {
                const prev = seenTags.get(t);
                if (prev !== undefined) {
                    errors.push(e(`${path}.fields[${i}].tag`, `duplicate tag ${t} (also on fields[${prev}])`));
                } else {
                    seenTags.set(t, i);
                }
            }
        });
    }

    if ("methods" in schema && schema["methods"] !== undefined) {
        if (!isArr(schema["methods"])) {
            errors.push(e(`${path}.methods`, "must be an array when present"));
        } else {
            schema["methods"].forEach((m, i) => errors.push(...checkMethod(m, `${path}.methods[${i}]`)));
        }
    }

    // Schema-domain metadata (edge / composite indexes / ephemeral) rides in the
    // `extensions['schema']` slice; other domains' slices are tolerated and ignored here.
    const sExts = schema["extensions"];
    if (sExts !== undefined) {
        if (!isObj(sExts)) {
            errors.push(e(`${path}.extensions`, "must be an object when present"));
        } else {
            errors.push(...checkSchemaExt(sExts[SCHEMA_EXT], `${path}.extensions.${SCHEMA_EXT}`));
        }
    }

    errors.push(...checkSourceLocation(schema["source"], `${path}.source`));
    return errors;
}

/** The schema domain's per-schema extension slice: `{ edge?, indexes?, ephemeral? }`. */
function checkSchemaExt(ext: unknown, path: string): IRValidationError[] {
    if (ext === undefined) return [];
    if (!isObj(ext)) return [e(path, "must be an object when present")];
    const errors: IRValidationError[] = [];
    if ("edge" in ext && ext["edge"] !== undefined) {
        errors.push(...checkEdge(ext["edge"], `${path}.edge`));
    }
    if ("indexes" in ext && ext["indexes"] !== undefined) {
        if (!isArr(ext["indexes"])) {
            errors.push(e(`${path}.indexes`, "must be an array when present"));
        } else {
            ext["indexes"].forEach((idx, i) => errors.push(...checkIndex(idx, `${path}.indexes[${i}]`)));
        }
    }
    if ("ephemeral" in ext && ext["ephemeral"] !== undefined && !isBool(ext["ephemeral"])) {
        errors.push(e(`${path}.ephemeral`, "must be a boolean when present"));
    }
    return errors;
}

/** The schema domain's per-field extension slice: `{ indexes?, ephemeral?, validators?, formatters? }`. */
function checkFieldExt(ext: unknown, path: string): IRValidationError[] {
    if (ext === undefined) return [];
    if (!isObj(ext)) return [e(path, "must be an object when present")];
    const errors: IRValidationError[] = [];
    if ("indexes" in ext && ext["indexes"] !== undefined) {
        if (!isArr(ext["indexes"])) {
            errors.push(e(`${path}.indexes`, "must be an array when present"));
        } else {
            ext["indexes"].forEach((idx, i) => errors.push(...checkFieldIndex(idx, `${path}.indexes[${i}]`)));
        }
    }
    if ("ephemeral" in ext && ext["ephemeral"] !== undefined && !isBool(ext["ephemeral"])) {
        errors.push(e(`${path}.ephemeral`, "must be a boolean when present"));
    }
    if ("validators" in ext && ext["validators"] !== undefined) {
        if (!isArr(ext["validators"])) {
            errors.push(e(`${path}.validators`, "must be an array when present"));
        } else {
            ext["validators"].forEach((v, i) => errors.push(...checkValidator(v, `${path}.validators[${i}]`)));
        }
    }
    if ("formatters" in ext && ext["formatters"] !== undefined) {
        if (!isArr(ext["formatters"])) {
            errors.push(e(`${path}.formatters`, "must be an array when present"));
        } else {
            ext["formatters"].forEach((f, i) => errors.push(...checkFormatter(f, `${path}.formatters[${i}]`)));
        }
    }
    return errors;
}

/** The UI domain's per-field slice (`field.extensions['ui']`): an optional `@FormField`. */
function checkFieldUiExt(ext: unknown, path: string): IRValidationError[] {
    if (ext === undefined) return [];
    if (!isObj(ext)) return [e(path, "must be an object when present")];
    if ("form" in ext && ext["form"] !== undefined) {
        return checkFormField(ext["form"], `${path}.form`);
    }
    return [];
}

function checkEdge(edge: unknown, path: string): IRValidationError[] {
    if (!isObj(edge)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    if (!isStr(edge["from"]) || edge["from"] === "") errors.push(e(`${path}.from`, "must be a non-empty string"));
    if (!isStr(edge["fromField"]) || edge["fromField"] === "") errors.push(e(`${path}.fromField`, "must be a non-empty string"));
    if (!isStr(edge["to"]) || edge["to"] === "") errors.push(e(`${path}.to`, "must be a non-empty string"));
    if (!isStr(edge["toField"]) || edge["toField"] === "") errors.push(e(`${path}.toField`, "must be a non-empty string"));
    if (!isStr(edge["label"]) || edge["label"] === "") errors.push(e(`${path}.label`, "must be a non-empty string"));
    if (!isBool(edge["directed"])) errors.push(e(`${path}.directed`, "must be a boolean"));
    return errors;
}

function checkField(field: unknown, path: string): IRValidationError[] {
    if (!isObj(field)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];

    if (!isStr(field["name"]) || field["name"] === "") errors.push(e(`${path}.name`, "must be a non-empty string"));
    errors.push(...checkType(field["type"], `${path}.type`));
    if (field["visibility"] !== "public" && field["visibility"] !== "private") {
        errors.push(e(`${path}.visibility`, 'must be "public" or "private"'));
    }
    if (!isBool(field["readonly"])) errors.push(e(`${path}.readonly`, "must be a boolean"));
    if (!isBool(field["required"])) errors.push(e(`${path}.required`, "must be a boolean"));
    if ("nullable" in field && field["nullable"] !== undefined && !isBool(field["nullable"])) {
        errors.push(e(`${path}.nullable`, "must be a boolean when present"));
    }

    if ("default" in field && field["default"] !== undefined) {
        errors.push(...checkDefault(field["default"], `${path}.default`));
    }
    if ("deprecated" in field && field["deprecated"] !== undefined
        && !isBool(field["deprecated"]) && !isStr(field["deprecated"])) {
        errors.push(e(`${path}.deprecated`, "must be a boolean or string when present"));
    }
    // Binary wire tag — a positive integer when present (structural backstop to the
    // frontend's semantic assignTags checks). Per-schema uniqueness is checked in checkSchema.
    if ("tag" in field && field["tag"] !== undefined) {
        const t = field["tag"];
        if (!isNum(t) || !Number.isInteger(t) || t < 1) {
            errors.push(e(`${path}.tag`, "must be a positive integer when present"));
        }
    }

    // Schema-domain per-field metadata (indexes / ephemeral) rides in the
    // `extensions['schema']` slice; the UI domain's `@FormField` metadata rides in the
    // `extensions['ui']` slice. Any other domain's slice is tolerated and ignored here.
    const fExts = field["extensions"];
    if (fExts !== undefined) {
        if (!isObj(fExts)) {
            errors.push(e(`${path}.extensions`, "must be an object when present"));
        } else {
            errors.push(...checkFieldExt(fExts[SCHEMA_EXT], `${path}.extensions.${SCHEMA_EXT}`));
            errors.push(...checkFieldUiExt(fExts[UI_EXT], `${path}.extensions.${UI_EXT}`));
        }
    }

    errors.push(...checkSourceLocation(field["source"], `${path}.source`));
    return errors;
}

function checkDefault(d: unknown, path: string): IRValidationError[] {
    if (!isObj(d)) return [e(path, "must be an object")];
    switch (d["kind"]) {
        case "literal": {
            const v = d["value"];
            if (v !== null && !isStr(v) && !isNum(v) && !isBool(v) && !isArr(v)) {
                return [e(`${path}.value`, "must be a string, number, boolean, null, or array")];
            }
            return [];
        }
        case "expression":
            return checkExpression(d["expression"], `${path}.expression`);
        default:
            return [e(`${path}.kind`, 'must be "literal" or "expression"')];
    }
}

function checkFormField(form: unknown, path: string): IRValidationError[] {
    if (!isObj(form)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    for (const key of ["title", "hint", "placeholder", "group"]) {
        if (key in form && form[key] !== undefined && !isStr(form[key])) {
            errors.push(e(`${path}.${key}`, "must be a string when present"));
        }
    }
    if ("order" in form && form["order"] !== undefined && !isNum(form["order"])) {
        errors.push(e(`${path}.order`, "must be a number when present"));
    }
    return errors;
}

function checkValidator(v: unknown, path: string): IRValidationError[] {
    if (!isObj(v)) return [e(path, "must be an object")];
    if (!isStr(v["name"]) || v["name"] === "") return [e(`${path}.name`, "must be a non-empty string")];
    if ("params" in v && v["params"] !== undefined && !isObj(v["params"])) {
        return [e(`${path}.params`, "must be an object when present")];
    }
    return [];
}

const FORMATTER_PHASES = new Set(["change", "blur", "submit", "save"]);

function checkFormatter(f: unknown, path: string): IRValidationError[] {
    if (!isObj(f)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    if (!isStr(f["phase"]) || !FORMATTER_PHASES.has(f["phase"])) {
        errors.push(e(`${path}.phase`, 'must be "change", "blur", "submit", or "save"'));
    }
    errors.push(...checkFormatterSpec(f["spec"], `${path}.spec`));
    return errors;
}

function checkFormatterSpec(spec: unknown, path: string): IRValidationError[] {
    if (!isObj(spec)) return [e(path, "must be an object")];
    if (!isStr(spec["name"]) || spec["name"] === "") return [e(`${path}.name`, "must be a non-empty string")];
    if ("params" in spec && spec["params"] !== undefined && !isObj(spec["params"])) {
        return [e(`${path}.params`, "must be an object when present")];
    }
    return [];
}

const INDEX_DIRECTIONS = new Set<unknown>([1, -1, "text"]);

function checkFieldIndex(idx: unknown, path: string): IRValidationError[] {
    if (!isObj(idx)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    if ("unique" in idx && idx["unique"] !== undefined && !isBool(idx["unique"])) {
        errors.push(e(`${path}.unique`, "must be a boolean when present"));
    }
    if ("sparse" in idx && idx["sparse"] !== undefined && !isBool(idx["sparse"])) {
        errors.push(e(`${path}.sparse`, "must be a boolean when present"));
    }
    if ("direction" in idx && idx["direction"] !== undefined && !INDEX_DIRECTIONS.has(idx["direction"])) {
        errors.push(e(`${path}.direction`, 'must be 1, -1, or "text" when present'));
    }
    if ("key" in idx && idx["key"] !== undefined && !isStr(idx["key"])) {
        errors.push(e(`${path}.key`, "must be a string when present"));
    }
    return errors;
}

function checkIndex(idx: unknown, path: string): IRValidationError[] {
    if (!isObj(idx)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];

    if (!isArr(idx["fields"])) {
        errors.push(e(`${path}.fields`, "must be an array"));
    } else {
        idx["fields"].forEach((f, i) => {
            if (!isObj(f)) { errors.push(e(`${path}.fields[${i}]`, "must be an object")); return; }
            if (!isStr(f["name"]) || f["name"] === "") errors.push(e(`${path}.fields[${i}].name`, "must be a non-empty string"));
            if (!INDEX_DIRECTIONS.has(f["direction"])) errors.push(e(`${path}.fields[${i}].direction`, 'must be 1, -1, or "text"'));
        });
    }

    if ("unique" in idx && idx["unique"] !== undefined && !isBool(idx["unique"])) {
        errors.push(e(`${path}.unique`, "must be a boolean when present"));
    }
    if ("sparse" in idx && idx["sparse"] !== undefined && !isBool(idx["sparse"])) {
        errors.push(e(`${path}.sparse`, "must be a boolean when present"));
    }
    if ("name" in idx && idx["name"] !== undefined && !isStr(idx["name"])) {
        errors.push(e(`${path}.name`, "must be a string when present"));
    }
    return errors;
}

function checkFunctionDeclaration(decl: unknown, path: string): IRValidationError[] {
    if (!isObj(decl)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    if (!isStr(decl["name"]) || decl["name"] === "") errors.push(e(`${path}.name`, "must be a non-empty string"));
    if (!isArr(decl["params"])) {
        errors.push(e(`${path}.params`, "must be an array"));
    } else {
        decl["params"].forEach((p, i) => errors.push(...checkParam(p, `${path}.params[${i}]`)));
    }
    errors.push(...checkType(decl["returnType"], `${path}.returnType`));
    if ("async" in decl && decl["async"] !== undefined && !isBool(decl["async"])) {
        errors.push(e(`${path}.async`, "must be a boolean when present"));
    }
    if (!isArr(decl["statements"])) {
        errors.push(e(`${path}.statements`, "must be an array"));
    } else {
        decl["statements"].forEach((s, i) => errors.push(...checkStatement(s, `${path}.statements[${i}]`)));
    }
    errors.push(...checkSourceLocation(decl["source"], `${path}.source`));
    return errors;
}

function checkEnumDeclaration(decl: unknown, path: string): IRValidationError[] {
    if (!isObj(decl)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    if (!isStr(decl["name"]) || decl["name"] === "") errors.push(e(`${path}.name`, "must be a non-empty string"));
    if (!isArr(decl["members"])) {
        errors.push(e(`${path}.members`, "must be an array"));
    } else {
        decl["members"].forEach((m, i) => {
            if (!isObj(m)) { errors.push(e(`${path}.members[${i}]`, "must be an object")); return; }
            if (!isStr(m["name"]) || m["name"] === "") errors.push(e(`${path}.members[${i}].name`, "must be a non-empty string"));
            if (!isStr(m["value"])) errors.push(e(`${path}.members[${i}].value`, "must be a string"));
        });
    }
    errors.push(...checkSourceLocation(decl["source"], `${path}.source`));
    return errors;
}

function checkMethod(m: unknown, path: string): IRValidationError[] {
    if (!isObj(m)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    if (!isStr(m["name"]) || m["name"] === "") errors.push(e(`${path}.name`, "must be a non-empty string"));
    if (m["kind"] !== "method" && m["kind"] !== "setter" && m["kind"] !== "getter"
        && m["kind"] !== "constructor" && m["kind"] !== "destructor") {
        errors.push(e(`${path}.kind`, 'must be "method", "setter", "getter", "constructor", or "destructor"'));
    }
    if (!isArr(m["params"])) {
        errors.push(e(`${path}.params`, "must be an array"));
    } else {
        m["params"].forEach((p, i) => errors.push(...checkParam(p, `${path}.params[${i}]`)));
    }
    if ("returnType" in m && m["returnType"] !== undefined) {
        errors.push(...checkType(m["returnType"], `${path}.returnType`));
    }
    if ("async" in m && m["async"] !== undefined && !isBool(m["async"])) {
        errors.push(e(`${path}.async`, "must be a boolean when present"));
    }
    if (m["visibility"] !== "public" && m["visibility"] !== "private") {
        errors.push(e(`${path}.visibility`, 'must be "public" or "private"'));
    }
    if (!isArr(m["statements"])) {
        errors.push(e(`${path}.statements`, "must be an array"));
    } else {
        m["statements"].forEach((s, i) => errors.push(...checkStatement(s, `${path}.statements[${i}]`)));
    }
    errors.push(...checkSourceLocation(m["source"], `${path}.source`));
    return errors;
}

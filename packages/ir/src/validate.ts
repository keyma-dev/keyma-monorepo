import type { KeymaIR } from "./types.js";

export type IRValidationError = {
    path: string;
    message: string;
};

export type IRValidationResult = {
    valid: boolean;
    errors: IRValidationError[];
};

export function validateIR(doc: unknown): IRValidationResult {
    const errors = checkDocument(doc, "");
    return { valid: errors.length === 0, errors };
}

function e(path: string, message: string): IRValidationError {
    return { path, message };
}

function isStr(v: unknown): v is string { return typeof v === "string"; }
function isNum(v: unknown): v is number { return typeof v === "number"; }
function isBool(v: unknown): v is boolean { return typeof v === "boolean"; }
function isArr(v: unknown): v is unknown[] { return Array.isArray(v); }
function isObj(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkDocument(doc: unknown, _path: string): IRValidationError[] {
    if (!isObj(doc)) return [e("", "IR document must be an object")];
    const errors: IRValidationError[] = [];

    if (!isStr(doc["irVersion"])) errors.push(e("irVersion", "must be a string"));
    if (!isStr(doc["compilerVersion"])) errors.push(e("compilerVersion", "must be a string"));

    if (!isArr(doc["schemas"])) {
        errors.push(e("schemas", "must be an array"));
    } else {
        doc["schemas"].forEach((s, i) => errors.push(...checkSchema(s, `schemas[${i}]`)));
    }

    if (!isArr(doc["diagnostics"])) {
        errors.push(e("diagnostics", "must be an array"));
    } else {
        doc["diagnostics"].forEach((d, i) => errors.push(...checkDiagnostic(d, `diagnostics[${i}]`)));
    }

    return errors;
}

function checkSchema(schema: unknown, path: string): IRValidationError[] {
    if (!isObj(schema)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];

    if (!isStr(schema["id"]) || schema["id"] === "") errors.push(e(`${path}.id`, "must be a non-empty string"));
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

    if (!isArr(schema["fields"])) {
        errors.push(e(`${path}.fields`, "must be an array"));
    } else {
        schema["fields"].forEach((f, i) => errors.push(...checkField(f, `${path}.fields[${i}]`)));
    }

    if (!isArr(schema["indexes"])) {
        errors.push(e(`${path}.indexes`, "must be an array"));
    } else {
        schema["indexes"].forEach((idx, i) => errors.push(...checkIndex(idx, `${path}.indexes[${i}]`)));
    }

    if ("edge" in schema && schema["edge"] !== undefined) {
        errors.push(...checkEdge(schema["edge"], `${path}.edge`));
    }

    errors.push(...checkSourceLocation(schema["source"], `${path}.source`));
    return errors;
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

    if (!isArr(field["validators"])) {
        errors.push(e(`${path}.validators`, "must be an array"));
    } else {
        field["validators"].forEach((v, i) => errors.push(...checkValidator(v, `${path}.validators[${i}]`)));
    }

    if (!isArr(field["formatters"])) {
        errors.push(e(`${path}.formatters`, "must be an array"));
    } else {
        field["formatters"].forEach((f, i) => errors.push(...checkFormatter(f, `${path}.formatters[${i}]`)));
    }

    if (!isArr(field["indexes"])) {
        errors.push(e(`${path}.indexes`, "must be an array"));
    } else {
        field["indexes"].forEach((idx, i) => errors.push(...checkFieldIndex(idx, `${path}.indexes[${i}]`)));
    }

    if ("computed" in field && field["computed"] !== undefined) {
        errors.push(...checkComputed(field["computed"], `${path}.computed`));
    }

    errors.push(...checkSourceLocation(field["source"], `${path}.source`));
    return errors;
}

const SCALAR_TYPE_KINDS = new Set([
    "string", "number", "integer", "bigint", "decimal", "boolean",
    "bytes", "json", "date", "dateTime", "time", "id"
]);

function checkType(type: unknown, path: string): IRValidationError[] {
    if (!isObj(type)) return [e(path, "must be an object")];
    if (!isStr(type["kind"])) return [e(`${path}.kind`, "must be a string")];

    const kind = type["kind"];

    if (SCALAR_TYPE_KINDS.has(kind)) return [];

    switch (kind) {
        case "enum": {
            if (!isArr(type["values"])) return [e(`${path}.values`, "must be an array")];
            if (type["values"].length === 0) return [e(`${path}.values`, "must not be empty")];
            const bad = type["values"].findIndex(v => !isStr(v));
            if (bad !== -1) return [e(`${path}.values[${bad}]`, "must be a string")];
            return [];
        }
        case "nullable":
        case "array":
            return checkType(type["of"], `${path}.of`);
        case "reference":
        case "embedded":
            if (!isStr(type["schema"]) || type["schema"] === "") {
                return [e(`${path}.schema`, "must be a non-empty string")];
            }
            return [];
        default:
            return [e(`${path}.kind`, `unknown type kind "${kind}"`)];
    }
}

const VALIDATOR_KINDS_SCALAR = new Set([
    "required", "positive", "nonNegative", "negative", "nonPositive",
    "integer", "uniqueItems", "emailAddress"
]);
const VALIDATOR_KINDS_NUMBER = new Set(["minLength", "maxLength", "length", "min", "max", "multipleOf", "minItems", "maxItems"]);
const VALIDATOR_KINDS_DATE_STR = new Set(["minDate", "maxDate"]);

function checkValidator(v: unknown, path: string): IRValidationError[] {
    if (!isObj(v)) return [e(path, "must be an object")];
    if (!isStr(v["kind"])) return [e(`${path}.kind`, "must be a string")];

    const kind = v["kind"];
    if (VALIDATOR_KINDS_SCALAR.has(kind)) return [];

    if (VALIDATOR_KINDS_NUMBER.has(kind)) {
        if (!isNum(v["value"])) return [e(`${path}.value`, "must be a number")];
        return [];
    }

    if (VALIDATOR_KINDS_DATE_STR.has(kind)) {
        if (!isStr(v["value"])) return [e(`${path}.value`, "must be a string")];
        return [];
    }

    switch (kind) {
        case "pattern":
            if (!isStr(v["pattern"])) return [e(`${path}.pattern`, "must be a string")];
            if ("flags" in v && v["flags"] !== undefined && !isStr(v["flags"])) {
                return [e(`${path}.flags`, "must be a string when present")];
            }
            return [];
        case "url":
            if ("protocols" in v && v["protocols"] !== undefined) {
                if (!isArr(v["protocols"])) return [e(`${path}.protocols`, "must be an array when present")];
                const bad = v["protocols"].findIndex(p => !isStr(p));
                if (bad !== -1) return [e(`${path}.protocols[${bad}]`, "must be a string")];
            }
            return [];
        case "phoneNumber":
            if ("region" in v && v["region"] !== undefined && !isStr(v["region"])) {
                return [e(`${path}.region`, "must be a string when present")];
            }
            return [];
        case "ipAddress":
            if ("version" in v && v["version"] !== undefined && v["version"] !== "v4" && v["version"] !== "v6") {
                return [e(`${path}.version`, 'must be "v4" or "v6" when present')];
            }
            return [];
        case "oneOf": {
            if (!isArr(v["values"])) return [e(`${path}.values`, "must be an array")];
            const bad = v["values"].findIndex(val => !isStr(val) && !isNum(val));
            if (bad !== -1) return [e(`${path}.values[${bad}]`, "must be a string or number")];
            return [];
        }
        case "custom":
            if (!isStr(v["name"]) || v["name"] === "") return [e(`${path}.name`, "must be a non-empty string")];
            return [];
        default:
            return [e(`${path}.kind`, `unknown validator kind "${kind}"`)];
    }
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

const FORMATTER_SPEC_SCALAR = new Set([
    "trim", "lowercase", "uppercase", "titleCase", "capitalize",
    "normalizeWhitespace", "stripNonDigits", "normalizeEmail", "normalizeUrl", "slugify"
]);

function checkFormatterSpec(spec: unknown, path: string): IRValidationError[] {
    if (!isObj(spec)) return [e(path, "must be an object")];
    if (!isStr(spec["kind"])) return [e(`${path}.kind`, "must be a string")];

    const kind = spec["kind"];
    if (FORMATTER_SPEC_SCALAR.has(kind)) return [];

    switch (kind) {
        case "normalizePhone":
            if ("region" in spec && spec["region"] !== undefined && !isStr(spec["region"])) {
                return [e(`${path}.region`, "must be a string when present")];
            }
            return [];
        case "truncate":
            if (!isNum(spec["maxLength"])) return [e(`${path}.maxLength`, "must be a number")];
            return [];
        case "custom":
            if (!isStr(spec["name"]) || spec["name"] === "") return [e(`${path}.name`, "must be a non-empty string")];
            return [];
        default:
            return [e(`${path}.kind`, `unknown formatter spec kind "${kind}"`)];
    }
}

function checkFieldIndex(idx: unknown, path: string): IRValidationError[] {
    if (!isObj(idx)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    if ("unique" in idx && idx["unique"] !== undefined && !isBool(idx["unique"])) {
        errors.push(e(`${path}.unique`, "must be a boolean when present"));
    }
    if ("sparse" in idx && idx["sparse"] !== undefined && !isBool(idx["sparse"])) {
        errors.push(e(`${path}.sparse`, "must be a boolean when present"));
    }
    if ("text" in idx && idx["text"] !== undefined && !isBool(idx["text"])) {
        errors.push(e(`${path}.text`, "must be a boolean when present"));
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
            if (f["direction"] !== 1 && f["direction"] !== -1) errors.push(e(`${path}.fields[${i}].direction`, "must be 1 or -1"));
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

function checkExpression(expr: unknown, path: string): IRValidationError[] {
    if (!isObj(expr)) return [e(path, "must be an object")];
    if (!isStr(expr["kind"])) return [e(`${path}.kind`, "must be a string")];

    const kind = expr["kind"];
    switch (kind) {
        case "literal": {
            const v = expr["value"];
            if (v !== null && !isStr(v) && !isNum(v) && !isBool(v)) {
                return [e(`${path}.value`, "must be string, number, boolean, or null")];
            }
            return [];
        }
        case "field":
            if (!isStr(expr["name"]) || expr["name"] === "") return [e(`${path}.name`, "must be a non-empty string")];
            return [];
        case "member": {
            const errors = checkExpression(expr["object"], `${path}.object`);
            if (!isStr(expr["member"]) || expr["member"] === "") errors.push(e(`${path}.member`, "must be a non-empty string"));
            return errors;
        }
        case "template":
            if (!isArr(expr["parts"])) return [e(`${path}.parts`, "must be an array")];
            return expr["parts"].flatMap((p, i) => checkExpression(p, `${path}.parts[${i}]`));
        case "binary": {
            const BINARY_OPS = new Set(["+", "-", "*", "/", "%", "&&", "||", "??", "==", "!=", "<", "<=", ">", ">="]);
            const errors: IRValidationError[] = [];
            if (!isStr(expr["op"]) || !BINARY_OPS.has(expr["op"])) errors.push(e(`${path}.op`, "unknown binary operator"));
            errors.push(...checkExpression(expr["left"], `${path}.left`));
            errors.push(...checkExpression(expr["right"], `${path}.right`));
            return errors;
        }
        case "unary": {
            const UNARY_OPS = new Set(["!", "-", "+"]);
            const errors: IRValidationError[] = [];
            if (!isStr(expr["op"]) || !UNARY_OPS.has(expr["op"])) errors.push(e(`${path}.op`, "unknown unary operator"));
            errors.push(...checkExpression(expr["operand"], `${path}.operand`));
            return errors;
        }
        case "conditional": {
            const errors = checkExpression(expr["condition"], `${path}.condition`);
            errors.push(...checkExpression(expr["whenTrue"], `${path}.whenTrue`));
            errors.push(...checkExpression(expr["whenFalse"], `${path}.whenFalse`));
            return errors;
        }
        default:
            return [e(`${path}.kind`, `unknown expression kind "${kind}"`)];
    }
}

function checkComputed(computed: unknown, path: string): IRValidationError[] {
    if (!isObj(computed)) return [e(path, "must be an object")];
    return checkExpression(computed["expression"], `${path}.expression`);
}

function checkSourceLocation(loc: unknown, path: string): IRValidationError[] {
    if (!isObj(loc)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    if (!isStr(loc["file"]) || loc["file"] === "") errors.push(e(`${path}.file`, "must be a non-empty string"));
    if (!isNum(loc["line"])) errors.push(e(`${path}.line`, "must be a number"));
    if (!isNum(loc["column"])) errors.push(e(`${path}.column`, "must be a number"));
    return errors;
}

function checkDiagnostic(diag: unknown, path: string): IRValidationError[] {
    if (!isObj(diag)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    if (!isStr(diag["code"]) || diag["code"] === "") errors.push(e(`${path}.code`, "must be a non-empty string"));
    if (diag["severity"] !== "error" && diag["severity"] !== "warning" && diag["severity"] !== "info") {
        errors.push(e(`${path}.severity`, 'must be "error", "warning", or "info"'));
    }
    if (!isStr(diag["message"])) errors.push(e(`${path}.message`, "must be a string"));
    if ("source" in diag && diag["source"] !== undefined) {
        errors.push(...checkSourceLocation(diag["source"], `${path}.source`));
    }
    return errors;
}

export type { KeymaIR };

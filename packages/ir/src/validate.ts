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

    if ("validatorDeclarations" in doc && doc["validatorDeclarations"] !== undefined) {
        if (!isArr(doc["validatorDeclarations"])) {
            errors.push(e("validatorDeclarations", "must be an array when present"));
        } else {
            doc["validatorDeclarations"].forEach((d, i) =>
                errors.push(...checkDeclaration(d, `validatorDeclarations[${i}]`)));
        }
    }

    if ("formatterDeclarations" in doc && doc["formatterDeclarations"] !== undefined) {
        if (!isArr(doc["formatterDeclarations"])) {
            errors.push(e("formatterDeclarations", "must be an array when present"));
        } else {
            doc["formatterDeclarations"].forEach((d, i) =>
                errors.push(...checkDeclaration(d, `formatterDeclarations[${i}]`)));
        }
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
    "bytes", "json", "date", "dateTime", "time", "id", "regexp"
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
        case "identifier":
            if (!isStr(expr["name"]) || expr["name"] === "") return [e(`${path}.name`, "must be a non-empty string")];
            return [];
        case "member": {
            const errors = checkExpression(expr["object"], `${path}.object`);
            if (!isStr(expr["member"]) || expr["member"] === "") errors.push(e(`${path}.member`, "must be a non-empty string"));
            return errors;
        }
        case "call": {
            const errors = checkExpression(expr["callee"], `${path}.callee`);
            if (!isArr(expr["args"])) {
                errors.push(e(`${path}.args`, "must be an array"));
            } else {
                expr["args"].forEach((a, i) => errors.push(...checkExpression(a, `${path}.args[${i}]`)));
            }
            return errors;
        }
        case "typeof":
            return checkExpression(expr["operand"], `${path}.operand`);
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
        case "object": {
            if (!isArr(expr["properties"])) return [e(`${path}.properties`, "must be an array")];
            const errors: IRValidationError[] = [];
            expr["properties"].forEach((prop, i) => {
                if (!isObj(prop)) { errors.push(e(`${path}.properties[${i}]`, "must be an object")); return; }
                if (!isStr(prop["key"]) || prop["key"] === "") errors.push(e(`${path}.properties[${i}].key`, "must be a non-empty string"));
                errors.push(...checkExpression(prop["value"], `${path}.properties[${i}].value`));
            });
            return errors;
        }
        case "regexp": {
            const errors: IRValidationError[] = [];
            if (!isStr(expr["pattern"])) errors.push(e(`${path}.pattern`, "must be a string"));
            if (!isStr(expr["flags"])) errors.push(e(`${path}.flags`, "must be a string"));
            return errors;
        }
        case "arrow": {
            const errors: IRValidationError[] = [];
            if (!isArr(expr["params"])) {
                errors.push(e(`${path}.params`, "must be an array"));
            } else {
                expr["params"].forEach((p, i) => {
                    if (!isStr(p) || p === "") errors.push(e(`${path}.params[${i}]`, "must be a non-empty string"));
                });
            }
            errors.push(...checkExpression(expr["body"], `${path}.body`));
            return errors;
        }
        case "new": {
            const errors = checkExpression(expr["callee"], `${path}.callee`);
            if (!isArr(expr["args"])) {
                errors.push(e(`${path}.args`, "must be an array"));
            } else {
                expr["args"].forEach((a, i) => errors.push(...checkExpression(a, `${path}.args[${i}]`)));
            }
            return errors;
        }
        default:
            return [e(`${path}.kind`, `unknown expression kind "${kind}"`)];
    }
}

function checkStatement(stmt: unknown, path: string): IRValidationError[] {
    if (!isObj(stmt)) return [e(path, "must be an object")];
    if (!isStr(stmt["kind"])) return [e(`${path}.kind`, "must be a string")];

    const kind = stmt["kind"];
    switch (kind) {
        case "return": {
            if (stmt["value"] !== null && stmt["value"] !== undefined) {
                return checkExpression(stmt["value"], `${path}.value`);
            }
            return [];
        }
        case "if": {
            const errors = checkExpression(stmt["condition"], `${path}.condition`);
            if (!isArr(stmt["consequent"])) {
                errors.push(e(`${path}.consequent`, "must be an array"));
            } else {
                stmt["consequent"].forEach((s, i) => errors.push(...checkStatement(s, `${path}.consequent[${i}]`)));
            }
            if ("alternate" in stmt && stmt["alternate"] !== undefined) {
                if (!isArr(stmt["alternate"])) {
                    errors.push(e(`${path}.alternate`, "must be an array when present"));
                } else {
                    stmt["alternate"].forEach((s, i) => errors.push(...checkStatement(s, `${path}.alternate[${i}]`)));
                }
            }
            return errors;
        }
        case "const": {
            const errors: IRValidationError[] = [];
            if (!isStr(stmt["name"]) || stmt["name"] === "") errors.push(e(`${path}.name`, "must be a non-empty string"));
            errors.push(...checkExpression(stmt["init"], `${path}.init`));
            return errors;
        }
        case "expression":
            return checkExpression(stmt["expr"], `${path}.expr`);
        default:
            return [e(`${path}.kind`, `unknown statement kind "${kind}"`)];
    }
}

function checkFunctionBody(body: unknown, path: string): IRValidationError[] {
    if (!isObj(body)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];

    if (!isArr(body["params"])) {
        errors.push(e(`${path}.params`, "must be an array"));
    } else {
        body["params"].forEach((p, i) => {
            if (!isObj(p)) { errors.push(e(`${path}.params[${i}]`, "must be an object")); return; }
            if (!isStr(p["name"]) || p["name"] === "") errors.push(e(`${path}.params[${i}].name`, "must be a non-empty string"));
            if (p["role"] !== "value" && p["role"] !== "field" && p["role"] !== "spec" && p["role"] !== "context") {
                errors.push(e(`${path}.params[${i}].role`, 'must be "value", "field", "spec", or "context"'));
            }
        });
    }

    if (!isArr(body["statements"])) {
        errors.push(e(`${path}.statements`, "must be an array"));
    } else {
        body["statements"].forEach((s, i) => errors.push(...checkStatement(s, `${path}.statements[${i}]`)));
    }

    return errors;
}

function checkDeclaration(decl: unknown, path: string): IRValidationError[] {
    if (!isObj(decl)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    if (!isStr(decl["name"]) || decl["name"] === "") errors.push(e(`${path}.name`, "must be a non-empty string"));
    if (!isArr(decl["factoryParams"])) {
        errors.push(e(`${path}.factoryParams`, "must be an array"));
    } else {
        decl["factoryParams"].forEach((p, i) => {
            if (!isObj(p)) { errors.push(e(`${path}.factoryParams[${i}]`, "must be an object")); return; }
            if (!isStr(p["name"]) || p["name"] === "") errors.push(e(`${path}.factoryParams[${i}].name`, "must be a non-empty string"));
        });
    }
    errors.push(...checkFunctionBody(decl["body"], `${path}.body`));
    errors.push(...checkSourceLocation(decl["source"], `${path}.source`));
    return errors;
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

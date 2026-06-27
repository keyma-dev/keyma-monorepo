import type { KeymaIR } from "./types.js";
import { intrinsicByOp } from "./intrinsics.js";

export type IRValidationError = {
    path: string;
    message: string;
};

export type IRValidationResult = {
    valid: boolean;
    errors: IRValidationError[];
};

/**
 * A document-level IR check. Receives the document (already confirmed to be an object)
 * and returns any structural errors it found.
 */
export type IRDocumentValidator = (doc: Record<string, unknown>) => IRValidationError[];

/**
 * Orchestrates IR document validation over an ordered list of registered checks. The
 * default registry (`defaultIRValidators`) is seeded with the **domain-neutral envelope
 * checks only** (irVersion/compilerVersion + diagnostics); the schema-domain section
 * checks live in `@keyma/schema/ir` and are registered onto this registry by the CLI.
 * This seam lets a domain register additional IR validators without editing this
 * orchestrator. Validators run in registration order and their errors are concatenated.
 */
export class IRValidatorRegistry {
    private readonly validators: IRDocumentValidator[] = [];

    /** Append a document validator. It runs after all previously-registered validators. */
    register(validator: IRDocumentValidator): void {
        this.validators.push(validator);
    }

    validate(doc: unknown): IRValidationResult {
        if (!isObj(doc)) return { valid: false, errors: [e("", "IR document must be an object")] };
        const errors = this.validators.flatMap((v) => v(doc));
        return { valid: errors.length === 0, errors };
    }
}

export function validateIR(doc: unknown): IRValidationResult {
    return defaultIRValidators.validate(doc);
}

export function e(path: string, message: string): IRValidationError {
    return { path, message };
}

export function isStr(v: unknown): v is string { return typeof v === "string"; }
export function isNum(v: unknown): v is number { return typeof v === "number"; }
export function isBool(v: unknown): v is boolean { return typeof v === "boolean"; }
export function isArr(v: unknown): v is unknown[] { return Array.isArray(v); }
export function isObj(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Core IR envelope — document version metadata. Registered first (runs before the sections). */
export function checkEnvelopeHead(doc: Record<string, unknown>): IRValidationError[] {
    const errors: IRValidationError[] = [];
    if (!isStr(doc["irVersion"])) errors.push(e("irVersion", "must be a string"));
    if (!isStr(doc["compilerVersion"])) errors.push(e("compilerVersion", "must be a string"));
    return errors;
}

/** Core IR envelope tail — the diagnostics array. Registered last (runs after the sections). */
export function checkEnvelopeTail(doc: Record<string, unknown>): IRValidationError[] {
    const errors: IRValidationError[] = [];
    if (!isArr(doc["diagnostics"])) {
        errors.push(e("diagnostics", "must be an array"));
    } else {
        doc["diagnostics"].forEach((d, i) => errors.push(...checkDiagnostic(d, `diagnostics[${i}]`)));
    }
    return errors;
}

/**
 * The default IR validator registry — domain-neutral envelope checks plus the base-language
 * `services` section. `@Service`/RPC is a base-language concern the compiler owns end-to-end,
 * so its IR-section checks live in core and are built in here (not contributed by a domain).
 * The schema-domain section checks (classes/enums/declarations) live in `@keyma/schema/ir` and
 * are appended here by the CLI. For a valid IR document every check produces zero errors, so
 * registration order has no observable effect on output.
 */
export const defaultIRValidators = new IRValidatorRegistry();
defaultIRValidators.register(checkEnvelopeHead);
defaultIRValidators.register(checkServices);
defaultIRValidators.register(checkEnvelopeTail);

/** Core IR section — the `services` array (base-language `@Service`/RPC contracts). */
export function checkServices(doc: Record<string, unknown>): IRValidationError[] {
    if (!("services" in doc) || doc["services"] === undefined) return [];
    if (!isArr(doc["services"])) return [e("services", "must be an array when present")];
    const errors: IRValidationError[] = [];
    doc["services"].forEach((s, i) => errors.push(...checkService(s, `services[${i}]`)));
    return errors;
}

/** Shared check for a `{ name, type, optional? }` typed parameter (service methods, functions). */
export function checkParam(p: unknown, path: string): IRValidationError[] {
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

const SCALAR_TYPE_KINDS = new Set([
    "string", "number", "integer", "bigint", "decimal", "boolean",
    "bytes", "json", "date", "dateTime", "time", "id"
]);

/** Validate a portable IR type node (scalars, numeric width/sign, enum, array, reference, embedded). */
export function checkType(type: unknown, path: string): IRValidationError[] {
    if (!isObj(type)) return [e(path, "must be an object")];
    if (!isStr(type["kind"])) return [e(`${path}.kind`, "must be a string")];

    const kind = type["kind"];

    // Numeric scalars carry optional width/sign metadata; validate it before the
    // generic scalar short-circuit below. Omitted `bits` means 64; omitted
    // `unsigned` means signed. `unsigned` applies to integers only.
    if (kind === "number" || kind === "integer") {
        const errors: IRValidationError[] = [];
        const allowedBits = kind === "number" ? [32, 64] : [8, 16, 32, 64];
        if ("bits" in type && type["bits"] !== undefined && !allowedBits.includes(type["bits"] as number)) {
            errors.push(e(`${path}.bits`, `must be one of ${allowedBits.join(", ")} when present`));
        }
        if (kind === "integer" && "unsigned" in type && type["unsigned"] !== undefined && !isBool(type["unsigned"])) {
            errors.push(e(`${path}.unsigned`, "must be a boolean when present"));
        }
        return errors;
    }

    if (SCALAR_TYPE_KINDS.has(kind)) return [];

    switch (kind) {
        case "enum": {
            if (!isArr(type["values"])) return [e(`${path}.values`, "must be an array")];
            if (type["values"].length === 0) return [e(`${path}.values`, "must not be empty")];
            const bad = type["values"].findIndex(v => !isStr(v));
            if (bad !== -1) return [e(`${path}.values[${bad}]`, "must be a string")];
            if ("name" in type && type["name"] !== undefined && !isStr(type["name"])) {
                return [e(`${path}.name`, "must be a string when present")];
            }
            return [];
        }
        case "array": {
            const errors = checkType(type["of"], `${path}.of`);
            if ("elementNullable" in type && type["elementNullable"] !== undefined && !isBool(type["elementNullable"])) {
                errors.push(e(`${path}.elementNullable`, "must be a boolean when present"));
            }
            return errors;
        }
        case "reference": {
            if (!isStr(type["target"]) || type["target"] === "") {
                return [e(`${path}.target`, "must be a non-empty string")];
            }
            if ("idType" in type && type["idType"] !== undefined) {
                return checkType(type["idType"], `${path}.idType`);
            }
            return [];
        }
        case "embedded":
            if (!isStr(type["target"]) || type["target"] === "") {
                return [e(`${path}.target`, "must be a non-empty string")];
            }
            return [];
        case "instance":
        case "external":
        case "typeVar":
            if (!isStr(type["name"]) || type["name"] === "") {
                return [e(`${path}.name`, "must be a non-empty string")];
            }
            return [];
        case "function": {
            const errors: IRValidationError[] = [];
            if (!isArr(type["params"])) {
                errors.push(e(`${path}.params`, "must be an array"));
            } else {
                type["params"].forEach((p, i) => {
                    if (!isObj(p)) { errors.push(e(`${path}.params[${i}]`, "must be an object")); return; }
                    if (!isStr(p["name"]) || p["name"] === "") errors.push(e(`${path}.params[${i}].name`, "must be a non-empty string"));
                    errors.push(...checkType(p["type"], `${path}.params[${i}].type`));
                });
            }
            if ("returns" in type && type["returns"] !== undefined) {
                errors.push(...checkType(type["returns"], `${path}.returns`));
            }
            return errors;
        }
        default:
            return [e(`${path}.kind`, `unknown type kind "${kind}"`)];
    }
}

/**
 * Validate an optional `typeArgs` map on a function-value reference (`identifier`/`call`):
 * an object whose keys are non-empty type-parameter names and whose values are valid IR
 * types (the concrete bindings). Absent ⇒ no error (non-generic reference).
 */
export function checkTypeArgs(typeArgs: unknown, path: string): IRValidationError[] {
    if (typeArgs === undefined) return [];
    if (!isObj(typeArgs)) return [e(path, "must be an object when present")];
    const errors: IRValidationError[] = [];
    for (const [key, value] of Object.entries(typeArgs)) {
        if (key === "") errors.push(e(path, "type-arg keys must be non-empty strings"));
        errors.push(...checkType(value, `${path}.${key}`));
    }
    return errors;
}

/** Validate a portable IR expression node (the restricted, re-emittable expression subset). */
export function checkExpression(expr: unknown, path: string): IRValidationError[] {
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
        case "identifier": {
            const errors: IRValidationError[] = [];
            if (!isStr(expr["name"]) || expr["name"] === "") errors.push(e(`${path}.name`, "must be a non-empty string"));
            errors.push(...checkTypeArgs(expr["typeArgs"], `${path}.typeArgs`));
            return errors;
        }
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
            errors.push(...checkTypeArgs(expr["typeArgs"], `${path}.typeArgs`));
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
                    // A param is either a bare name (string) or a typed `{ name, type?, optional? }`.
                    if (isStr(p)) {
                        if (p === "") errors.push(e(`${path}.params[${i}]`, "must be a non-empty string"));
                    } else if (isObj(p)) {
                        if (!isStr(p["name"]) || p["name"] === "") errors.push(e(`${path}.params[${i}].name`, "must be a non-empty string"));
                        if ("type" in p && p["type"] !== undefined) errors.push(...checkType(p["type"], `${path}.params[${i}].type`));
                        if ("optional" in p && p["optional"] !== undefined && !isBool(p["optional"])) errors.push(e(`${path}.params[${i}].optional`, "must be a boolean when present"));
                    } else {
                        errors.push(e(`${path}.params[${i}]`, "must be a non-empty string or a typed param object"));
                    }
                });
            }
            // Exactly one of `body` (concise) or `statements` (block) must be present.
            const hasBody = expr["body"] !== undefined;
            const hasStmts = expr["statements"] !== undefined;
            if (hasBody === hasStmts) {
                errors.push(e(path, "arrow must have exactly one of `body` or `statements`"));
            }
            if (hasBody) errors.push(...checkExpression(expr["body"], `${path}.body`));
            if (hasStmts) {
                if (!isArr(expr["statements"])) {
                    errors.push(e(`${path}.statements`, "must be an array"));
                } else {
                    expr["statements"].forEach((s, i) => errors.push(...checkStatement(s, `${path}.statements[${i}]`)));
                }
            }
            if ("returnType" in expr && expr["returnType"] !== undefined) {
                errors.push(...checkType(expr["returnType"], `${path}.returnType`));
            }
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
        case "await":
            return checkExpression(expr["operand"], `${path}.operand`);
        case "intrinsic": {
            const errors: IRValidationError[] = [];
            if (!isStr(expr["op"]) || expr["op"] === "") {
                errors.push(e(`${path}.op`, "must be a non-empty string"));
            } else if (intrinsicByOp(expr["op"]) === undefined) {
                errors.push(e(`${path}.op`, `unknown intrinsic op "${expr["op"]}" (not in the intrinsic registry)`));
            }
            if (expr["receiver"] !== null) errors.push(...checkExpression(expr["receiver"], `${path}.receiver`));
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

/** Validate a portable IR statement node (const/if/return/expression/assign subset). */
export function checkStatement(stmt: unknown, path: string): IRValidationError[] {
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
        case "assign": {
            const errors = checkExpression(stmt["target"], `${path}.target`);
            errors.push(...checkExpression(stmt["value"], `${path}.value`));
            return errors;
        }
        case "forOf": {
            const errors: IRValidationError[] = [];
            if (!isStr(stmt["name"]) || stmt["name"] === "") errors.push(e(`${path}.name`, "must be a non-empty string"));
            errors.push(...checkExpression(stmt["iterable"], `${path}.iterable`));
            if (!isArr(stmt["body"])) {
                errors.push(e(`${path}.body`, "must be an array"));
            } else {
                stmt["body"].forEach((s, i) => errors.push(...checkStatement(s, `${path}.body[${i}]`)));
            }
            return errors;
        }
        case "while": {
            const errors = checkExpression(stmt["condition"], `${path}.condition`);
            if (!isArr(stmt["body"])) {
                errors.push(e(`${path}.body`, "must be an array"));
            } else {
                stmt["body"].forEach((s, i) => errors.push(...checkStatement(s, `${path}.body[${i}]`)));
            }
            return errors;
        }
        case "break":
        case "continue":
            return [];
        case "switch": {
            const errors = checkExpression(stmt["discriminant"], `${path}.discriminant`);
            if (!isArr(stmt["cases"])) {
                errors.push(e(`${path}.cases`, "must be an array"));
            } else {
                stmt["cases"].forEach((c, i) => {
                    if (!isObj(c)) { errors.push(e(`${path}.cases[${i}]`, "must be an object")); return; }
                    // `test` must be present: an expression for a case label, or `null` for `default`.
                    if (!("test" in c)) {
                        errors.push(e(`${path}.cases[${i}].test`, "must be present (an expression, or null for default)"));
                    } else if (c["test"] !== null) {
                        errors.push(...checkExpression(c["test"], `${path}.cases[${i}].test`));
                    }
                    if (!isArr(c["body"])) {
                        errors.push(e(`${path}.cases[${i}].body`, "must be an array"));
                    } else {
                        c["body"].forEach((s, j) => errors.push(...checkStatement(s, `${path}.cases[${i}].body[${j}]`)));
                    }
                });
            }
            return errors;
        }
        default:
            return [e(`${path}.kind`, `unknown statement kind "${kind}"`)];
    }
}

export function checkSourceLocation(loc: unknown, path: string): IRValidationError[] {
    if (!isObj(loc)) return [e(path, "must be an object")];
    const errors: IRValidationError[] = [];
    if (!isStr(loc["file"]) || loc["file"] === "") errors.push(e(`${path}.file`, "must be a non-empty string"));
    if (!isNum(loc["line"])) errors.push(e(`${path}.line`, "must be a number"));
    if (!isNum(loc["column"])) errors.push(e(`${path}.column`, "must be a number"));
    return errors;
}

export function checkDiagnostic(diag: unknown, path: string): IRValidationError[] {
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

import type { IRType, IRField } from "@keyma/ir";

/**
 * Map an IRType to its C++ type (std::pmr throughout). `cppTypeByName` resolves an
 * embedded/reference target's `name` to its fully-qualified emitted struct type;
 * `enumTypeByName` resolves a named enum to its fully-qualified `enum class` type.
 * A `reference` lowers to `std::shared_ptr<T>` (id-stub materialized via
 * `std::allocate_shared`); a NAMED enum to its `enum class`; an inline string union
 * (no `name`) stays `std::pmr::string` (the value set is enforced by the validator
 * path, mirroring the Python backend's `Literal[...]`).
 */
export function irTypeToCpp(
    type: IRType,
    cppTypeByName?: ReadonlyMap<string, string>,
    enumTypeByName?: ReadonlyMap<string, string>,
): string {
    switch (type.kind) {
        case "string":
        case "id":
        case "date":
        case "time":
        case "decimal":
            return "std::pmr::string";
        case "enum":
            return type.name !== undefined
                ? enumTypeByName?.get(type.name) ?? "std::pmr::string"
                : "std::pmr::string";
        case "number":
            return type.bits === 32 ? "float" : "double";
        case "integer": {
            const w = type.bits ?? 64;
            const s = type.unsigned ? "std::uint" : "std::int";
            return `${s}${w}_t`; // std::int8_t … std::uint64_t
        }
        case "bigint":
            return "std::int64_t";
        case "boolean":
            return "bool";
        case "bytes":
            return "std::pmr::vector<std::byte>";
        case "json":
            return "keyma::Value";
        case "dateTime":
            return "keyma::DateTime";
        case "array": {
            const el = irTypeToCpp(type.of, cppTypeByName, enumTypeByName);
            return type.elementNullable ? `std::pmr::vector<std::optional<${el}>>` : `std::pmr::vector<${el}>`;
        }
        case "reference":
            // A reference is a shared, allocator-aware handle to the target model
            // (id-stub at minimum). The null pointer models absence/null.
            return `std::shared_ptr<${cppTypeByName?.get(type.schema) ?? type.schema}>`;
        case "embedded":
            return cppTypeByName?.get(type.schema) ?? type.schema;
    }
}

/**
 * The declared C++ type of a struct member, composing the orthogonal presence/value
 * axes: `T` when required & non-nullable; `std::optional<T>` when only one axis is
 * loose; `keyma::Field<T>` when a field is BOTH optional (may be absent) and nullable
 * (may be null), so the two empties stay distinct without `optional<optional<T>>`.
 * A `reference` is exempt: `std::shared_ptr<T>` already models absence (null pointer),
 * so it is never wrapped.
 */
export function memberType(
    field: IRField,
    cppTypeByName?: ReadonlyMap<string, string>,
    enumTypeByName?: ReadonlyMap<string, string>,
): string {
    const core = irTypeToCpp(field.type, cppTypeByName, enumTypeByName);
    if (field.type.kind === "reference") return core;
    const optional = !field.required;
    const nullable = field.nullable === true;
    if (optional && nullable) return `keyma::Field<${core}>`;
    if (optional || nullable) return `std::optional<${core}>`;
    return core;
}

/**
 * The serialization template argument for a field, plus whether it is a two-axis
 * `keyma::Field<E>`. The generated value_traits emit
 * `keyma::from_value<tmpl>(v.at("k"), a)` for a normal member, and
 * `keyma::from_value_field<tmpl>(v.find("k"), a)` for a `Field` member — the only kind
 * needing true absent-vs-present-null presence (`find` returns nullptr for an absent key,
 * which `at` cannot express). For a `Field`, `tmpl` is the INNER type E (the runtime's
 * `from_value_field` supplies the `Field<E>` wrapper); otherwise it is the full member type.
 */
export function traitsArg(
    field: IRField,
    cppTypeByName?: ReadonlyMap<string, string>,
    enumTypeByName?: ReadonlyMap<string, string>,
): { tmpl: string; field: boolean } {
    const optional = !field.required;
    const nullable = field.nullable === true;
    if (field.type.kind !== "reference" && optional && nullable) {
        return { tmpl: irTypeToCpp(field.type, cppTypeByName, enumTypeByName), field: true };
    }
    return { tmpl: memberType(field, cppTypeByName, enumTypeByName), field: false };
}

/**
 * The logical (unwrapped) C++ value type a typed where/projection operand compares
 * against, for the emitted field descriptors (`struct f`, consumed by keyma/query.hpp).
 * Strips the array wrapper (an array field compares against its element); a reference
 * compares against the TARGET's id type; a json/embedded against keyma::Value. The
 * presence/nullability wrappers are intentionally dropped — a filter compares the value.
 */
export function whereValueType(
    field: IRField,
    cppTypeByName?: ReadonlyMap<string, string>,
    enumTypeByName?: ReadonlyMap<string, string>,
): string {
    const core = field.type.kind === "array" ? field.type.of : field.type;
    switch (core.kind) {
        case "reference":
            return core.idType !== undefined
                ? irTypeToCpp(core.idType, cppTypeByName, enumTypeByName)
                : "std::pmr::string";
        case "embedded":
        case "json":
            return "keyma::Value";
        default:
            return irTypeToCpp(core, cppTypeByName, enumTypeByName);
    }
}

/** The keyma::FieldKind enumerator for a field's descriptor (an array → its element's kind). */
export function fieldKind(field: IRField): string {
    const core = field.type.kind === "array" ? field.type.of : field.type;
    let k: string;
    switch (core.kind) {
        case "string": case "id": case "date": case "time": case "decimal":
        case "number": case "integer": case "bigint": case "dateTime":
            k = "Ordered"; break;
        case "enum":
            k = core.name !== undefined ? "Enum" : "Ordered"; break;  // named enum vs inline string-union
        case "boolean": case "bytes":
            k = "Scalar"; break;
        case "reference":
            k = "Reference"; break;
        case "json": case "embedded": case "array":
            k = "Json"; break;
    }
    return `keyma::FieldKind::${k}`;
}

/** The descriptor's RefTarget type (the target struct for a reference field, else void). */
export function refTargetType(field: IRField, cppTypeByName?: ReadonlyMap<string, string>): string {
    const core = field.type.kind === "array" ? field.type.of : field.type;
    if (core.kind === "reference") return cppTypeByName?.get(core.schema) ?? core.schema;
    return "void";
}

/** The keyma::TypeTag enumerator for a type, for schema metadata. */
export function typeTag(type: IRType): string {
    const map: Record<IRType["kind"], string> = {
        string: "String", number: "Number", integer: "Integer", bigint: "BigInt",
        decimal: "Decimal", boolean: "Boolean", bytes: "Bytes", json: "Json",
        date: "Date", dateTime: "DateTime", time: "Time", id: "Id",
        enum: "Enum", array: "Array", reference: "Reference", embedded: "Embedded",
    };
    return `keyma::TypeTag::${map[type.kind]}`;
}

/**
 * How a validator/formatter body binds its dynamically-typed `value` parameter to a
 * concrete C++ value coerced from the incoming `keyma::Value`. Returns the declared
 * type of the binding and the initializer expression applied to `rawVar`. For
 * `json`/`reference`/`embedded`/`dateTime` the binding is the Value itself (the body
 * operates on it directly).
 */
export function valueBinding(type: IRType, rawVar: string): { cppType: string; init: string } {
    switch (type.kind) {
        case "string":
        case "id":
        case "date":
        case "time":
        case "decimal":
        case "enum":
            return { cppType: "const std::pmr::string&", init: `${rawVar}.as_string()` };
        case "number":
            return { cppType: "double", init: `${rawVar}.as_double()` };
        case "integer":
        case "bigint":
            return { cppType: "std::int64_t", init: `${rawVar}.as_int()` };
        case "boolean":
            return { cppType: "bool", init: `${rawVar}.as_bool()` };
        case "bytes":
            return { cppType: "const std::pmr::vector<std::byte>&", init: `${rawVar}.as_bytes()` };
        case "array":
            return { cppType: "const keyma::Value::Array&", init: `${rawVar}.as_array()` };
        case "json":
        case "reference":
        case "embedded":
        case "dateTime":
            return { cppType: "const keyma::Value&", init: rawVar };
    }
}

/**
 * A C++ boolean expression checking whether a `keyma::Value` named `value` structurally
 * matches `type`, for a validator/formatter runtime input guard. Returns null when no
 * meaningful check applies (json, dateTime, schema references).
 */
export function irTypeGuard(type: IRType, value: string): string | null {
    switch (type.kind) {
        case "string":
        case "id":
        case "date":
        case "time":
        case "decimal":
        case "enum":
            return `${value}.is_string()`;
        case "number":
            return `${value}.is_number()`;
        case "integer":
        case "bigint":
            return `${value}.is_int()`;
        case "boolean":
            return `${value}.is_bool()`;
        case "bytes":
            return `${value}.is_bytes()`;
        case "array":
            return `${value}.is_array()`;
        case "dateTime":
        case "json":
        case "reference":
        case "embedded":
            return null;
    }
}

/** A short human label for a type, used in runtime mismatch messages. */
export function irTypeLabel(type: IRType): string {
    switch (type.kind) {
        case "array": return `list of ${irTypeLabel(type.of)}`;
        case "enum": return `one of ${type.values.map((v) => JSON.stringify(v)).join(", ")}`;
        case "reference":
        case "embedded": return type.schema;
        default: return type.kind;
    }
}

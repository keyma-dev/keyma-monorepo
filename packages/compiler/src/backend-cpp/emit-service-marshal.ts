import type { IRType } from "@keyma/core/ir";
import { irTypeToCpp } from "./ir-type-to-cpp.js";

// Per-argument / per-return RPC marshalling — the shared codec the generated service `dispatch`
// (server) and the generated client method use. It mirrors runtime-js `rpc.ts`: positional args
// in declared order, each value lowered through the SAME per-type codec the model serializer uses
// (JSON: value_traits to_value/from_value; binary: binary_traits encode_payload/decode_payload).
//
//   * JSON mode — args as a named-arg object; result as the bare value (void → null).
//   * Binary mode — args as the positional payloads concatenated (declared order, no names, no
//     keys); result as the bare payload (void → empty bytes).
//
// Almost every IR kind round-trips uniformly: a `reference` (its `std::shared_ptr<T>` id-stub
// carries the bare id via `to_value`/`binary_traits<shared_ptr<T>>`), an `embedded` (its value
// type's full-record codec), and the scalars/enums/arrays all flow through `to_value` / from_value
// / binary_traits<cpp>. The lone exception is `instance` (a param/return-only "live value of class
// T", which the cross-language contract sends as the FULL object, not the id): its C++ lowering is
// `std::shared_ptr<T>`, whose default codec is id-only — so the full-object form is emitted by hand.

type Maps = {
    cppTypeByName: ReadonlyMap<string, string>;
    enumTypeByName: ReadonlyMap<string, string>;
};

/** The target struct type of an `instance` (a "live value of class T"), else undefined. */
function instanceTarget(t: IRType, maps: Maps): string | undefined {
    return t.kind === "instance" ? (maps.cppTypeByName.get(t.name) ?? t.name) : undefined;
}

export function cppType(type: IRType, maps: Maps): string {
    return irTypeToCpp(type, maps.cppTypeByName, maps.enumTypeByName);
}

// ── JSON ──────────────────────────────────────────────────────────────────────

/** Lower a value of `type` to a `keyma::Value` (the JSON-mode arg/result payload). */
export function jsonEncode(type: IRType, valueExpr: string, alloc: string, maps: Maps): string {
    const inst = instanceTarget(type, maps);
    if (inst !== undefined) {
        // A live instance is sent as its full object (shared_ptr → its to_value, not the id).
        return `(${valueExpr}) ? (${valueExpr})->to_value(${alloc}) : keyma::Value(nullptr, ${alloc})`;
    }
    if (type.kind === "array" && instanceTarget(type.of, maps) !== undefined) {
        const elem = instanceTarget(type.of, maps)!;
        void elem;
        // Array of live instances → array of full objects.
        return `[&]{ keyma::Value __a = keyma::Value::array(${alloc}); ` +
            `for (const auto& __e : ${valueExpr}) __a.push(__e ? __e->to_value(${alloc}) : keyma::Value(nullptr, ${alloc})); ` +
            `return __a; }()`;
    }
    return `keyma::to_value(${valueExpr}, ${alloc})`;
}

/** Hydrate a `keyma::Value` (`valueExpr`) into a value of `type` (the JSON-mode decode). */
export function jsonDecode(type: IRType, valueExpr: string, alloc: string, maps: Maps): string {
    // from_value<shared_ptr<T>> already hydrates a full object (when the Value is an object) or an
    // id-stub (when it is a scalar), so `instance` and `reference` both decode uniformly here.
    return `keyma::from_value<${cppType(type, maps)}>(${valueExpr}, ${alloc})`;
}

// ── Binary (positional) ─────────────────────────────────────────────────────────

/** Append the binary payload of `valueExpr` (type `type`) to `buf` (a `keyma::ByteBuf&`). */
export function binaryEncode(type: IRType, valueExpr: string, buf: string, alloc: string, maps: Maps): string {
    const inst = instanceTarget(type, maps);
    if (inst !== undefined) {
        // Full record (assume present): the shared_ptr's own binary_traits is id-only.
        return `keyma::binary_traits<${inst}>::encode_payload(${buf}, *(${valueExpr}), ${alloc});`;
    }
    if (type.kind === "array" && instanceTarget(type.of, maps) !== undefined) {
        const elem = instanceTarget(type.of, maps)!;
        return `{ keyma::ByteBuf __body(${alloc}); keyma::binary_detail::write_varint(__body, (${valueExpr}).size()); ` +
            `for (const auto& __e : ${valueExpr}) { keyma::binary_detail::put(__body, keyma::binary_traits<${elem}>::wiretype); ` +
            `keyma::binary_traits<${elem}>::encode_payload(__body, *__e, ${alloc}); } ` +
            `keyma::binary_detail::write_len_raw(${buf}, std::span<const std::byte>(__body.data(), __body.size())); }`;
    }
    const cpp = cppType(type, maps);
    return `keyma::binary_traits<${cpp}>::encode_payload(${buf}, ${valueExpr}, ${alloc});`;
}

/** Read a value of `type` out of `reader` (a `keyma::binary_detail::Reader&`) — the binary decode. */
export function binaryDecode(type: IRType, reader: string, alloc: string, maps: Maps): string {
    const inst = instanceTarget(type, maps);
    if (inst !== undefined) {
        // Full record → wrapped in a fresh shared_ptr (the live instance).
        return `std::allocate_shared<${inst}>(${alloc}, ` +
            `keyma::binary_traits<${inst}>::decode_payload(${reader}, keyma::binary_traits<${inst}>::wiretype, ${alloc}))`;
    }
    if (type.kind === "array" && instanceTarget(type.of, maps) !== undefined) {
        const elem = instanceTarget(type.of, maps)!;
        return `[&]{ keyma::binary_detail::Reader __inner = keyma::binary_detail::read_len_window(${reader}); ` +
            `std::uint64_t __n = keyma::binary_detail::read_varint(__inner); ` +
            `std::pmr::vector<std::shared_ptr<${elem}>> __out(${alloc}); __out.reserve(__n); ` +
            `for (std::uint64_t __i = 0; __i < __n; ++__i) { std::uint8_t __wt = std::to_integer<std::uint8_t>(__inner.buf[__inner.pos++]); ` +
            `__out.push_back(std::allocate_shared<${elem}>(${alloc}, keyma::binary_traits<${elem}>::decode_payload(__inner, __wt, ${alloc}))); } ` +
            `return __out; }()`;
    }
    const cpp = cppType(type, maps);
    return `keyma::binary_traits<${cpp}>::decode_payload(${reader}, keyma::binary_traits<${cpp}>::wiretype, ${alloc})`;
}

/** Heavyweight types pass by const-ref into a method param; scalars by value. */
export function passByRef(type: IRType): boolean {
    switch (type.kind) {
        case "string": case "id": case "date": case "time": case "decimal":
        case "bytes": case "json": case "array": case "embedded":
            return true;
        case "enum":
            return type.name === undefined; // inline union → pmr string (by ref); named enum → by value
        default:
            return false; // number/integer/bigint/boolean/dateTime/reference/instance (shared_ptr) → by value
    }
}

// RPC argument/result marshalling — the per-call codec the generated client and the generated
// service `dispatch` share. It encodes positional call args and the return value through the
// SAME per-type codec the model serializer uses (JSON: `serializeValue`/`deserializeValue`;
// binary: `encodePayload`/`decodeValue`), so the call wire reuses the model wire byte-for-byte.
//
// Both ends know the static param/return types (the generated code passes them in declared
// order), so nothing about types or names rides on the binary wire:
//   * JSON mode — args as a plain object keyed by param name; result as the bare value.
//   * Binary mode — args as the positional payloads concatenated (declared order, no names, no
//     keys; each value's wiretype is implied by its static type); result as the bare payload.
// A `void` return encodes to JSON `null` / an empty binary blob.

import type { ClassRef, FieldType } from "./fields.js";
import type { WireEncoding } from "./types.js";
import { serializeValue, type Refs } from "./serialize.js";
import { deserializeValue } from "./deserialize.js";
import { encodePayload, decodeValue, wiretypeOf, type Reader } from "./binary.js";

/** A positional call argument: its declared name (JSON key), value type, and value. */
export type ArgSpec = { name: string; type: FieldType; value: unknown };
/** A declared parameter the server decodes a positional argument into. */
export type ParamSpec = { name: string; type: FieldType };

export type RpcRefs = ReadonlyMap<string, ClassRef> | undefined;

// ── client side ──────────────────────────────────────────────────────────────

/** Encode a call's arguments into the `CallRequest.args` payload for `encoding`. */
export function encodeArgs(encoding: WireEncoding, args: readonly ArgSpec[], refs: RpcRefs): unknown {
    if (encoding === "binary") {
        const out: number[] = [];
        for (const a of args) encodePayload(out, a.type, a.value, refs as Refs);
        return Uint8Array.from(out);
    }
    const obj: Record<string, unknown> = {};
    for (const a of args) obj[a.name] = serializeValue(a.value, a.type, refs as Refs);
    return obj;
}

/** Decode a call's return payload (`CallResult.data`) for `encoding`. `type` absent ⇒ void. */
export function decodeResult(encoding: WireEncoding, data: unknown, type: FieldType | undefined, refs: RpcRefs): unknown {
    if (type === undefined) return undefined;
    if (encoding === "binary") {
        const r = reader(data);
        return decodeValue(r, type, wiretypeOf(type), refs as Refs);
    }
    return deserializeValue(data, type, refs as Refs);
}

// ── server side ──────────────────────────────────────────────────────────────

/** Decode positional call arguments from the `CallRequest.args` payload for `encoding`, in
 *  declared order. Returns the native argument list ready to spread into the impl. */
export function decodeArgs(encoding: WireEncoding, payload: unknown, params: readonly ParamSpec[], refs: RpcRefs): unknown[] {
    if (encoding === "binary") {
        const r = reader(payload);
        return params.map((p) => decodeValue(r, p.type, wiretypeOf(p.type), refs as Refs));
    }
    const obj = (payload ?? {}) as Record<string, unknown>;
    return params.map((p) => deserializeValue(obj[p.name], p.type, refs as Refs));
}

/** Encode a method's return value into the `CallResult.data` payload for `encoding`. `type`
 *  absent ⇒ void (`null` / empty bytes). */
export function encodeResult(encoding: WireEncoding, value: unknown, type: FieldType | undefined, refs: RpcRefs): unknown {
    if (encoding === "binary") {
        const out: number[] = [];
        if (type !== undefined) encodePayload(out, type, value, refs as Refs);
        return Uint8Array.from(out);
    }
    return type === undefined ? null : serializeValue(value, type, refs as Refs);
}

function reader(payload: unknown): Reader {
    const buf = payload instanceof Uint8Array ? payload : new Uint8Array(0);
    return { buf, pos: 0, end: buf.length };
}

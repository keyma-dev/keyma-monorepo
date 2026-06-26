// LEB128 varint + zigzag + fixed-width float helpers for the binary wire codec
// (see ../binary-format.md). Browser-safe: no Buffer; floats go through a shared DataView.
// Varints carry full unsigned 64-bit range, so values are read/written as `bigint`
// (callers pass plain `number` for tags/lengths/counts and convert results with `Number`).

const scratch = new DataView(new ArrayBuffer(8));

/** Append an unsigned LEB128 varint. Accepts a `number` (< 2^53) or a `bigint` (full u64). */
export function writeVarint(out: number[], value: number | bigint): void {
    let v = typeof value === "bigint" ? value : BigInt(value);
    if (v < 0n) throw new RangeError("writeVarint: value must be non-negative");
    while (v >= 0x80n) {
        out.push(Number(v & 0x7fn) | 0x80);
        v >>= 7n;
    }
    out.push(Number(v));
}

/** Read an unsigned LEB128 varint at `pos`; returns `[value, nextPos]`. */
export function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
    let result = 0n;
    let shift = 0n;
    let p = pos;
    for (;;) {
        const byte = buf[p++];
        if (byte === undefined) throw new RangeError("readVarint: truncated input");
        result |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7n;
    }
    return [result, p];
}

// Zigzag maps signed 64-bit integers to unsigned so small-magnitude negatives stay short.
export function zigzagEncode(n: bigint): bigint {
    return (n << 1n) ^ (n >> 63n);
}
export function zigzagDecode(u: bigint): bigint {
    return (u >> 1n) ^ -(u & 1n);
}

export function writeFloat64(out: number[], value: number): void {
    scratch.setFloat64(0, value, true);
    for (let i = 0; i < 8; i++) out.push(scratch.getUint8(i));
}
export function writeFloat32(out: number[], value: number): void {
    scratch.setFloat32(0, value, true);
    for (let i = 0; i < 4; i++) out.push(scratch.getUint8(i));
}
export function readFloat64(buf: Uint8Array, pos: number): number {
    for (let i = 0; i < 8; i++) scratch.setUint8(i, buf[pos + i] ?? 0);
    return scratch.getFloat64(0, true);
}
export function readFloat32(buf: Uint8Array, pos: number): number {
    for (let i = 0; i < 4; i++) scratch.setUint8(i, buf[pos + i] ?? 0);
    return scratch.getFloat32(0, true);
}

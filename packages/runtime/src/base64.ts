// Standard base64 (RFC 4648, alphabet `A-Za-z0-9+/`, `=` padding) — the canonical wire
// encoding for `bytes` fields, byte-compatible with the Python runtime's `base64` module and
// the C++ runtime's `keyma::detail::base64_encode`. Dependency-free and browser-safe: no
// `Buffer`, and no `String.fromCharCode(...bytes)` spread (which overflows the call stack on
// large buffers).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Reverse lookup: char code → 6-bit value (-1 for non-alphabet, incl. padding/whitespace).
const LOOKUP = /* @__PURE__ */ (() => {
    const t = new Int16Array(128).fill(-1);
    for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
    return t;
})();

export function bytesToBase64(bytes: Uint8Array): string {
    let out = "";
    const n = bytes.length;
    let i = 0;
    for (; i + 3 <= n; i += 3) {
        const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
        out +=
            ALPHABET[(v >> 18) & 63]! +
            ALPHABET[(v >> 12) & 63]! +
            ALPHABET[(v >> 6) & 63]! +
            ALPHABET[v & 63]!;
    }
    const rem = n - i;
    if (rem === 1) {
        const v = bytes[i]! << 16;
        out += ALPHABET[(v >> 18) & 63]! + ALPHABET[(v >> 12) & 63]! + "==";
    } else if (rem === 2) {
        const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
        out += ALPHABET[(v >> 18) & 63]! + ALPHABET[(v >> 12) & 63]! + ALPHABET[(v >> 6) & 63]! + "=";
    }
    return out;
}

export function base64ToBytes(s: string): Uint8Array {
    // Collect 6-bit groups, skipping padding and any stray whitespace/invalid chars.
    const sextets: number[] = [];
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        const v = c < 128 ? LOOKUP[c]! : -1;
        if (v >= 0) sextets.push(v);
    }
    const fullGroups = Math.floor(sextets.length / 4);
    const tail = sextets.length - fullGroups * 4; // 0, 2, or 3 (1 is malformed → ignored)
    const outLen = fullGroups * 3 + (tail === 3 ? 2 : tail === 2 ? 1 : 0);
    const out = new Uint8Array(outLen);
    let o = 0;
    let k = 0;
    for (let g = 0; g < fullGroups; g++, k += 4) {
        const v = (sextets[k]! << 18) | (sextets[k + 1]! << 12) | (sextets[k + 2]! << 6) | sextets[k + 3]!;
        out[o++] = (v >> 16) & 0xff;
        out[o++] = (v >> 8) & 0xff;
        out[o++] = v & 0xff;
    }
    if (tail === 2) {
        const v = (sextets[k]! << 18) | (sextets[k + 1]! << 12);
        out[o++] = (v >> 16) & 0xff;
    } else if (tail === 3) {
        const v = (sextets[k]! << 18) | (sextets[k + 1]! << 12) | (sextets[k + 2]! << 6);
        out[o++] = (v >> 16) & 0xff;
        out[o++] = (v >> 8) & 0xff;
    }
    return out;
}

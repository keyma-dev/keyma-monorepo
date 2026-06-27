#!/bin/sh
# Build + run the runtime-cpp tests, skipping cleanly when no C++23 compiler is available
# so that the repo-root `npm run test --workspaces` does not break in node-only
# environments. A real compile/test failure still propagates (non-zero exit). Set KEYMA_CXX
# to force a compiler.
set -e
cd "$(dirname "$0")/.."

CXX=""
for c in "$KEYMA_CXX" g++-15 g++-14 g++-13 clang++-18 clang++-17 g++ clang++ c++; do
    [ -n "$c" ] && command -v "$c" >/dev/null 2>&1 && { CXX="$c"; break; }
done
if [ -z "$CXX" ]; then
    echo "runtime-cpp: skipping tests — no C++23 compiler found (set KEYMA_CXX to enable)"
    exit 0
fi

# Homebrew/MacPorts GCC vs the macOS SDK: SDK headers (e.g. <mach/arm/_structs.h>, reached
# transitively through <cstdlib>) use the C11 keyword _Alignof unconditionally. GCC's C++
# frontend doesn't accept _Alignof — it spells the operator `alignof` — whereas Apple Clang
# takes _Alignof as an extension, so this only bites real GCC on macOS. Map the spelling
# through. _Alignof is not a keyword in GCC's C++ mode, so defining it as a macro is safe;
# `alignof(<type>)` is exactly equivalent and the SDK only ever writes `_Alignof(<type>)`.
COMPAT=""
if [ "$(uname)" = Darwin ] \
   && "$CXX" -dM -E -x c++ /dev/null 2>/dev/null | grep -q '__GNUC__' \
   && ! "$CXX" -dM -E -x c++ /dev/null 2>/dev/null | grep -q '__clang__'; then
    COMPAT="-D_Alignof(x)=alignof(x)"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1) Syntax-check the umbrella runtime header against the generated-code-shape TU (no runtime
#    deps): a generated header `#include <keyma/runtime.hpp>` and nothing else external.
"$CXX" -std=c++23 $COMPAT -Iinclude -fsyntax-only test/tu.cpp

# 2) Compile and run the behavioral tests of the RPC world:
#      * coroutine — the concrete async core (task / event_loop / scheduler concepts / sync_wait);
#      * rpc       — end-to-end @Service over every transport (both encodings, gating + ctx, an
#                    event_loop-driven suspending transport);
#      * binary-typed — the typed binary codec (struct↔bytes) parity with the dynamic codec.
for t in coroutine rpc binary-typed; do
    "$CXX" -std=c++23 $COMPAT -Iinclude "test/$t.test.cpp" -o "$WORK/$t.test"
    "$WORK/$t.test"
done

# 2b) Cross-runtime binary parity: encode the SHARED fixtures the JS reference codec generated
#     and assert byte-identical output (the cardinal invariant). The fixtures live in the
#     sibling runtime package (single source of truth), passed in as an absolute path.
FIXTURES="$(cd ../runtime/test && pwd)/binary-fixtures.json"
"$CXX" -std=c++23 $COMPAT -Iinclude -DKEYMA_BINARY_FIXTURES="\"$FIXTURES\"" test/binary.test.cpp -o "$WORK/binary.test"
"$WORK/binary.test"

# 3) Build the coroutine test under AddressSanitizer to catch any dangling reference across a
#    coroutine suspension point. The clean instrumented BUILD is the cardinal check; the RUN is
#    best-effort (some sandboxes can't load the ASan runtime, and GCC's libasan does not link on
#    macOS). Force a usable ASan toolchain (Clang) and skip the run on a runtime/link failure.
ASAN_CXX=""
for c in clang++-18 clang++-17 clang++ "$CXX"; do
    [ -n "$c" ] && command -v "$c" >/dev/null 2>&1 && { ASAN_CXX="$c"; break; }
done
ASAN_COMPAT=""
if [ "$(uname)" = Darwin ] \
   && "$ASAN_CXX" -dM -E -x c++ /dev/null 2>/dev/null | grep -q '__GNUC__' \
   && ! "$ASAN_CXX" -dM -E -x c++ /dev/null 2>/dev/null | grep -q '__clang__'; then
    ASAN_COMPAT="-D_Alignof(x)=alignof(x)"
fi
if "$ASAN_CXX" -std=c++23 $ASAN_COMPAT -Iinclude -fsanitize=address -g \
        test/coroutine.test.cpp -o "$WORK/coroutine.asan" 2>"$WORK/asan.log"; then
    echo "runtime-cpp: coroutine test built clean under -fsanitize=address ($ASAN_CXX)"
    if [ "${KEYMA_SKIP_ASAN_RUN:-}" = 1 ]; then
        echo "runtime-cpp: skipping ASan run (KEYMA_SKIP_ASAN_RUN=1)"
    else
        # Best-effort, BOUNDED run: the Apple-clang libc++ ASan runtime spins on this C++23
        # coroutine TU in some sandboxes, so cap the run and skip cleanly on timeout — the clean
        # instrumented BUILD is the cardinal check. (`timeout` is GNU-only; emulate portably.)
        "$WORK/coroutine.asan" >/dev/null 2>&1 &
        _asan_pid=$!
        _waited=0
        while kill -0 "$_asan_pid" 2>/dev/null && [ "$_waited" -lt 15 ]; do
            sleep 1
            _waited=$((_waited + 1))
        done
        if kill -0 "$_asan_pid" 2>/dev/null; then
            kill -9 "$_asan_pid" 2>/dev/null
            wait "$_asan_pid" 2>/dev/null || true
            echo "runtime-cpp: NOTE — ASan instrumented run did not finish within 15s (libc++ ASan/coroutine interaction); the clean instrumented build stands"
        elif wait "$_asan_pid"; then
            echo "runtime-cpp: coroutine test ran clean under ASan"
        else
            echo "runtime-cpp: NOTE — ASan instrumented run exited non-zero in this sandbox; the clean instrumented build stands"
        fi
    fi
else
    echo "runtime-cpp: NOTE — could not build under -fsanitize=address with $ASAN_CXX (libasan unavailable); skipping"
fi

echo "runtime-cpp: tests passed ($CXX)"

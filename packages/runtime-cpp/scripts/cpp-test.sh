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

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1) Syntax-check the runtime header against the generated-code-shape TU (no runtime deps).
"$CXX" -std=c++23 -Iinclude -fsyntax-only test/tu.cpp

# 2) Compile and run the behavioral tests: the server/client/json consumer layer under the
#    default Sync policy, and a std::future policy instantiation (proves the Async<> template
#    is not coupled to Sync — bring your own scheduler).
for t in server futures; do
    "$CXX" -std=c++23 -Iinclude "test/$t.test.cpp" -o "$WORK/$t.test"
    "$WORK/$t.test"
done

echo "runtime-cpp: tests passed ($CXX)"

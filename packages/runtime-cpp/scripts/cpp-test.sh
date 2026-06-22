#!/bin/sh
# Syntax-check the runtime header against a small consuming translation unit, skipping
# cleanly when no C++23 compiler is available so that the repo-root
# `npm run test --workspaces` does not break in node-only environments. A real compile
# failure still propagates (non-zero exit). Set KEYMA_CXX to force a compiler.
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

exec "$CXX" -std=c++23 -Iinclude -fsyntax-only test/tu.cpp

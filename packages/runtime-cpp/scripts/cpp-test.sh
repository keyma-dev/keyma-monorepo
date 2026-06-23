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
#    default Sync policy, a (blocking) std::future policy, and a genuinely-suspending C++23
#    coroutine-task policy — proving the Async<> template is not coupled to Sync (bring your
#    own scheduler) on both the eager and the deferred path.
for t in server futures coroutine typed; do
    "$CXX" -std=c++23 -Iinclude "test/$t.test.cpp" -o "$WORK/$t.test"
    "$WORK/$t.test"
done

# 3) Negative-compile: a mistyped filter must be REJECTED by the typed query DSL. A
#    non-zero exit from the compiler here is the PASS (the snippet is meant to fail).
NEG="$WORK/neg.cpp"
cat > "$NEG" <<'CPP'
#include <keyma/query.hpp>
#include <cstdint>
#include <string_view>
struct Rec {
    struct f {
        struct n_ { using Owner = Rec; using Value = std::int64_t; using RefTarget = void;
                    static constexpr std::string_view key() { return "n"; }
                    static constexpr keyma::FieldKind kind = keyma::FieldKind::Ordered; };
        static constexpr n_ n{};
    };
};
int main() { (void)keyma::eq(Rec::f::n, "not-an-int"); }  // string into an int field
CPP
if "$CXX" -std=c++23 -Iinclude -fsyntax-only "$NEG" 2>/dev/null; then
    echo "runtime-cpp: NEGATIVE-COMPILE TEST FAILED — a mistyped filter compiled"
    exit 1
fi
echo "runtime-cpp: negative-compile check passed (mistyped filter rejected)"

echo "runtime-cpp: tests passed ($CXX)"

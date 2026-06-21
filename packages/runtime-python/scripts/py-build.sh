#!/bin/sh
# Build the sdist + wheel, skipping cleanly when Python tooling is unavailable
# so that the repo-root `npm run build --workspaces` does not break in node-only
# environments. Real build failures still propagate (non-zero exit).
set -e
cd "$(dirname "$0")/.."

if ! command -v python3 >/dev/null 2>&1; then
    echo "runtime-python: skipping build — python3 not found"
    exit 0
fi
if ! python3 -c "import build" >/dev/null 2>&1; then
    echo "runtime-python: skipping build — 'build' not installed (run: pip install build)"
    exit 0
fi

exec python3 -m build

#!/bin/sh
# Run the Python test suite, skipping cleanly when Python tooling is unavailable
# so that the repo-root `npm run test --workspaces` does not break in node-only
# environments. Real test failures still propagate (non-zero exit).
set -e
cd "$(dirname "$0")/.."

if ! command -v python3 >/dev/null 2>&1; then
    echo "runtime-python: skipping tests — python3 not found"
    exit 0
fi
if ! python3 -c "import pytest" >/dev/null 2>&1; then
    echo "runtime-python: skipping tests — pytest not installed (run: pip install -e '.[dev]')"
    exit 0
fi

exec python3 -m pytest -q

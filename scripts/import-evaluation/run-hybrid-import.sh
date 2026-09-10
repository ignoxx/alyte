#!/usr/bin/env bash
set -euo pipefail

# Evaluation-only entry point. The TypeScript runner keeps adapter output private and prints only
# the safe aggregate summary. All arguments are intentionally forwarded so a Paddle adapter can
# be swapped without changing the runner.
exec node --import tsx "$(cd "$(dirname "$0")/../.." && pwd)/scripts/import-evaluation/hybrid-import-runner.ts" "$@"

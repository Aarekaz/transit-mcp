#!/usr/bin/env bash
set -euo pipefail
runner_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
exec node "$runner_root/scripts/run-conformance.mjs"

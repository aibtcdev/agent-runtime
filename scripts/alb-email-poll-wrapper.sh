#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec ~/.bun/bin/bun run "$SCRIPT_DIR/alb-email-poll.ts" "$@"

#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${AIBTC_HEARTBEAT_COMMAND:-}" ]]; then
  printf '%s\n' '{"status":"blocked","machine_status":"blocked","operator_summary":"AIBTC heartbeat command is not configured. Set AIBTC_HEARTBEAT_COMMAND in the host-local heartbeat env file after wallet, identity, and credential store setup are complete.","file_changes":[],"artifact_paths":[],"follow_up_tasks":[],"external_messages":[]}'
  exit 0
fi

exec ${AIBTC_HEARTBEAT_COMMAND} "$@"

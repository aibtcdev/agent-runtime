#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/update-agent-runtime.sh --agent <name> --host <user@host> [options]

Options:
  --agent <name>       Agent/systemd instance name, e.g. spark, forge, lumen
  --host <user@host>   SSH target, e.g. dev@192.168.1.12
  --repo-dir <path>    Remote repo directory (default: /home/dev/agent-runtime)
  --config <path>      Remote runtime config (default: ~/.config/agent-runtime/<agent>.host.json)
  --branch <name>      Git branch/ref to fast-forward from origin (default: main)
  --port <port>        Optional LAN API port to probe after restart
  --no-restart         Update and verify, but do not restart systemd services
  -h, --help           Show this help

The script stops dispatch before updating, backs up the runtime DB, fast-forwards
the repo, runs install/typecheck/tests/healthcheck, then restarts services.
USAGE
}

agent=""
host=""
repo_dir="/home/dev/agent-runtime"
config=""
branch="main"
port=""
restart_services=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      agent="${2:-}"
      shift 2
      ;;
    --host)
      host="${2:-}"
      shift 2
      ;;
    --repo-dir)
      repo_dir="${2:-}"
      shift 2
      ;;
    --config)
      config="${2:-}"
      shift 2
      ;;
    --branch)
      branch="${2:-}"
      shift 2
      ;;
    --port)
      port="${2:-}"
      shift 2
      ;;
    --no-restart)
      restart_services=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$agent" || -z "$host" ]]; then
  usage >&2
  exit 2
fi

if [[ -z "$config" ]]; then
  config="~/.config/agent-runtime/${agent}.host.json"
fi

if ssh "$host" "test -d '$repo_dir/.git'"; then
  sync_method="git"
else
  sync_method="rsync"
  rsync -az --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude 'state/' \
    --exclude 'config/state/' \
    --exclude 'deploy/*/state/' \
    --exclude 'deploy/*/runtime.*.host.json' \
    ./ "$host:$repo_dir/"
fi

remote_script=$(cat <<'REMOTE'
set -euo pipefail

agent="$1"
repo_dir="$2"
config="$3"
branch="$4"
port="$5"
restart_services="$6"
sync_method="$7"

cd "$repo_dir"
config="${config/#\~/$HOME}"

if [[ "$restart_services" == "1" ]]; then
  systemctl --user stop "agent-runtime-dispatch@${agent}.timer" || true
  systemctl --user stop "agent-runtime-operator@${agent}.service" || true
fi

db_path="deploy/${agent}/state/runtime.db"
if [[ -f "$db_path" ]]; then
  backup_path="${db_path}.bak.$(date +%Y%m%d%H%M%S)"
  cp "$db_path" "$backup_path"
  echo "Backed up DB: $backup_path"
else
  echo "No DB found at $db_path; skipping DB backup"
fi

if [[ "$sync_method" == "git" ]]; then
  git fetch origin
  git pull --ff-only origin "$branch"
else
  echo "Using rsync-supplied working tree; skipping remote git pull"
fi

~/.bun/bin/bun install
~/.bun/bin/bunx tsc --noEmit
~/.bun/bin/bun test
~/.bun/bin/bun run src/cli.ts healthcheck --config "$config"

# Force schema migrations to apply before services come back.
~/.bun/bin/bun run src/cli.ts status --config "$config" >/dev/null

if [[ "$restart_services" == "1" ]]; then
  systemctl --user daemon-reload
  systemctl --user start "agent-runtime-operator@${agent}.service"
  systemctl --user start "agent-runtime-dispatch@${agent}.timer"
  systemctl --user --no-pager --full status "agent-runtime-operator@${agent}.service"
  systemctl --user --no-pager --full status "agent-runtime-dispatch@${agent}.timer"
fi

if [[ -n "$port" ]]; then
  for attempt in 1 2 3 4 5; do
    if curl --fail --silent --show-error "http://127.0.0.1:${port}/api/heartbeat" >/dev/null \
      && curl --fail --silent --show-error "http://127.0.0.1:${port}/api/schedules" >/dev/null \
      && curl --fail --silent --show-error "http://127.0.0.1:${port}/api/sensors/events" >/dev/null; then
      echo "LAN API probes passed on port ${port}"
      break
    fi
    if [[ "$attempt" == "5" ]]; then
      echo "LAN API probes failed on port ${port}" >&2
      exit 1
    fi
    sleep 2
  done
fi

echo "Update completed for ${agent}"
REMOTE
)

ssh "$host" "bash -s -- '$agent' '$repo_dir' '$config' '$branch' '$port' '$restart_services' '$sync_method'" <<<"$remote_script"

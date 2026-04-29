# agent-runtime

Minimum runnable shared runtime extracted from the Phase 2 contract.

This proof keeps the runtime intentionally small:

- explicit task intake
- deterministic context assembly
- adapter-based execution
- SQLite persistence
- dispatch lock plus retry handling
- CLI operator controls
- LAN web/API operator visibility

Shared `agent-cli` driver support now exists for `codex`, `claude-code`, and `hermes-agent`. The current live Lumen proving config still enables only `ollama-generate` plus `codex` until the Claude and Hermes launch contracts are pinned per host.
The `script` adapter mode is also first-class for deterministic work such as AIBTC heartbeat, so those checks flow through the same task, attempt, SQLite, and audit-artifact path as model-backed dispatch.

The CLI is the primary agent execution surface: dispatch cycles, health checks, workflow transitions, and bridge intake run through `src/cli.ts`. The web server is the v1 LAN coordination surface for humans and sibling agents on the same private network. It exposes runtime state, tasks, events, artifacts, snapshots, and a bounded operator task queue endpoint.

## Lumen Status

Lumen is now live as a proving runtime on `dev@192.168.1.16` under `deploy/lumen/runtime.lumen.json`. The real host exit condition in `deploy/lumen/DEPLOY.md` has been satisfied:

- manual `github-story` bring-up passed
- manual `discord-reply` bring-up passed
- `agent-runtime-operator@lumen.service` is enabled and active
- `agent-runtime-dispatch@lumen.timer` is enabled and active
- the operator UI is reachable on `127.0.0.1:4314`
- Hermes remains intact beside the proving runtime

Current intended use is narrow and operator-facing:

- GitHub merge/PR story summaries
- Discord explanation/reply tasks
- small proving queues observed through the UI, LAN API, systemd logs, and runtime JSONL logs

For the live host, start with these paths and surfaces:

- runtime config: `deploy/lumen/runtime.lumen.json`
- host override example: `deploy/lumen/runtime.lumen.host.example.json`
- bring-up and host evidence: `deploy/lumen/DEPLOY.md`
- adapter contracts: `deploy/ADAPTER_CONTRACTS.md`
- clone contract: `deploy/CLONE_CONTRACT.md`
- agent package template: `templates/agent-package/`
- operator UI: `http://127.0.0.1:4314/`
- services: `agent-runtime-operator@lumen.service`, `agent-runtime-dispatch@lumen.timer`, `agent-runtime-run-once@lumen.service`


## Commands

Install a local config first:

```bash
cp config/runtime.example.json config/runtime.json
```

Queue a task:

```bash
bun run src/cli.ts intake --json '{
  "kind": "github-story",
  "source": "github",
  "priority": 5,
  "payload": {
    "repo": "aibtcdev/agent-runtime",
    "summary": "Summarize what this PR means for operators"
  },
  "requested_profile": "lumen"
}'
```

Queue a task for the future:

```bash
bun run src/cli.ts intake --json '{
  "kind": "aibtc-checkin",
  "source": "operator:future-checkin",
  "subject": "AIBTC check-in",
  "payload": { "check": "heartbeat" },
  "requested_adapter": "aibtc-heartbeat",
  "schedule": { "delay_minutes": 30 }
}'
```

Create a recurring schedule. Dispatch cycles run due schedules before workflow evaluation, and `schedule-tick` is available when operators want to enqueue due work explicitly.

```bash
bun run src/cli.ts schedule-create --json '{
  "name": "aibtc-checkin",
  "interval_seconds": 3600,
  "task": {
    "kind": "aibtc-checkin",
    "source": "schedule:aibtc-checkin",
    "subject": "AIBTC check-in",
    "payload": { "check": "heartbeat" },
    "requested_adapter": "aibtc-heartbeat"
  }
}'

bun run src/cli.ts schedule-tick
```

Catch-up policy is coalesced by default: each schedule evaluation creates at most one task for a due schedule, then advances `next_run_at` by one interval from the prior due time. This preserves evidence that a check was missed without flooding the queue after downtime. If a schedule remains behind, later dispatch cycles continue advancing it one interval at a time.

Ingest a sensor event. Sensor events are deduped by `dedupe_key` and may enqueue a task, create or reuse a workflow, or both.

```bash
bun run src/cli.ts sensor-event --json '{
  "sensor_id": "discord-mentions",
  "event_id": "message-123",
  "source_ref": "discord://channel/message-123",
  "dedupe_key": "discord:message-123",
  "payload": { "summary": "external request" },
  "proposed_workflow": {
    "template": "goal-loop",
    "instance_key": "discord-message-123",
    "context": {
      "summary": "Respond to Discord request",
      "objective": "Investigate and respond with evidence"
    }
  }
}'
```

Run one dispatch cycle:

```bash
bun run src/cli.ts run-once
```

Inspect runtime status:

```bash
bun run src/cli.ts status
```

Run health checks:

```bash
bun run src/cli.ts healthcheck
```

Run tests:

```bash
bun test
```

Update a remote agent runtime from this repo:

```bash
scripts/update-agent-runtime.sh --agent spark --host dev@192.168.1.12 --port 4314
scripts/update-agent-runtime.sh --agent forge --host dev@192.168.1.15 --port 4314
scripts/update-agent-runtime.sh --agent lumen --host dev@192.168.1.16 --port 4314
```

The update script stops dispatch, backs up the agent DB, fast-forwards the remote repo from `origin/main`, runs install/typecheck/tests/healthcheck, applies schema migrations through `status`, restarts services, and optionally probes the LAN API.

Create a workflow:

```bash
bun run src/cli.ts workflow-create \
  --template community-research \
  --instance_key lumen-community-wiki \
  --context '{"slug":"lumen-community-wiki","topic":"AIBTC community wiki","output_path":"community-wiki/aibtc-basics.md"}'
```

Inspect workflows:

```bash
bun run src/cli.ts workflow-list
bun run src/cli.ts workflow-show --instance_key lumen-community-wiki
```

Advance a workflow explicitly:

```bash
bun run src/cli.ts workflow-transition --id 1 --state draft-community-wiki-outline
```

Lumen proving deploy artifacts:

```text
deploy/lumen/runtime.lumen.json
deploy/lumen/DEPLOY.md
deploy/BASE_AGENT_CHECKLIST.md
deploy/systemd/agent-runtime-run-once@.service
deploy/systemd/agent-runtime-dispatch@.timer
deploy/systemd/agent-runtime-operator@.service
```

Use `deploy/lumen/DEPLOY.md` as the bring-up checklist. The current Lumen proving contract is intentionally narrow: GitHub-story runs are summary-only and should complete with `artifact_paths: []` unless Lumen explicitly writes managed artifacts.

For host-specific adapter wiring, keep the repo-safe base config unchanged and create a local sibling override that `extends` it. `deploy/lumen/runtime.lumen.host.example.json` shows the intended pattern for Claude and Hermes on Lumen.

If you deploy with `rsync --delete`, keep the real host override outside the synced repo tree, for example under `~/.config/agent-runtime/`, and use an absolute `extends` path back to the checked-in base config.

Run the operator UI and LAN API:

```bash
bun run src/web.ts --config config/runtime.json --host 127.0.0.1 --port 4314
```

LAN API surfaces:

- `/` static operator view
- `/api/state` runtime state, task counts, and last event
- `/api/heartbeat` lightweight liveness check
- `/api/workflows`, `/api/tasks`, `/api/events`
- `/api/schedules` list or upsert recurring schedules
- `POST /api/schedules/tick` enqueue due scheduled work
- `/api/sensors/events` list or ingest deduped sensor events
- `POST /api/tasks/queue` queue a bounded operator task with a JSON `message`
- `POST /api/tasks/:task_id/cancel` cancel a non-running task as `operator_canceled`
- `/api/pause` read or set runtime-owned dispatch pause state; paused dispatchers do not claim new work
- `/api/artifacts`, `/api/artifact`
- `/api/snapshots`, `/api/snapshot`, `/api/report`, `/api/report/latest`
- `/api/stream` live SSE updates
- `/artifacts`, `/snapshots` browser-readable JSON views for runtime inspection

Optional LAN fleet UI lives in the separate `aibtcdev/agent-runtime-ui` repo and can proxy multiple hosts that expose this API:

```bash
# git clone git@github.com:aibtcdev/agent-runtime-ui.git ~/agent-runtime-ui
# cd ~/agent-runtime-ui
# cp config/fleet.example.json config/fleet.json
# cp deploy/systemd/agent-runtime-ui.service ~/.config/systemd/user/
# systemctl --user daemon-reload
# systemctl --user enable --now agent-runtime-ui.service
```

Queue a Lumen GitHub task through the thin bridge:

```bash
bun run src/cli.ts bridge-github --file fixtures/github-pr-merged.json
```

Queue a Lumen Discord task through the thin bridge:

```bash
bun run src/cli.ts bridge-discord --file fixtures/discord-mention.json
```

## Layout

```text
agent-runtime/
  config/
  profiles/
  src/
  state/
```

The runtime does not include Discord business logic, GitHub polling, Arc identity, Loom publishing, or Forge fleet UI work. Those belong in thin bridges or later migrations.

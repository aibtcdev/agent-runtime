# Base Agent Checklist

This is the shared minimum for agent-runtime siblings before they are considered ready for routine LAN operation.

## Runtime

- `agent-runtime-operator@<agent>.service` is enabled and reachable on the LAN API port.
- `agent-runtime-dispatch@<agent>.timer` is enabled.
- The host override lives outside the synced repo tree, normally `~/.config/agent-runtime/<agent>.host.json`.
- `bunx tsc --noEmit`, `bun test`, and `bun run src/cli.ts healthcheck --config ~/.config/agent-runtime/<agent>.host.json` pass, except for explicitly blocked optional adapters.
- The fleet UI config has the agent endpoint after the runtime API is reachable.

## Credentials

- The encrypted credential store skill is installed.
- `CREDENTIALS_PASSWORD` is set only in a host-local `.env` or service environment file.
- Provider credentials and wallet passwords are stored in the encrypted credential store, not in checked-in runtime config.
- Agent memory/runbook documents the credential ids needed for normal operation without printing secret values.

## AIBTC Identity

- The AIBTC wallet skill is installed.
- The wallet exists on the agent VM and can be unlocked by retrieving `wallet-password` from the credential store.
- The agent has a registered AIBTC identity, or the exact registration blocker is recorded as a task artifact.
- The agent has an operator-readable runbook for wallet unlock, registration check, heartbeat, inbox read, and safe message reply.

## Heartbeat Through Dispatch

Heartbeat is a `script` adapter task, not an external sidecar. The dispatch timer claims it like any other task and records stdout, stderr, result JSON, attempts, retries, and task outcome in the same SQLite database.

Recommended adapter shape:

```json
{
  "aibtc-heartbeat": {
    "mode": "script",
    "command": "../../scripts/aibtc-heartbeat-wrapper.sh",
    "timeoutMs": 60000,
    "workingDir": "../..",
    "envFile": "/home/dev/.config/agent-runtime/<agent>.heartbeat.env"
  }
}
```

The host-local env file should set `AIBTC_HEARTBEAT_COMMAND` to the real heartbeat command once wallet and identity setup are proven. Until then, the wrapper returns a canonical `blocked` outcome so the missing prerequisite is visible in runtime history.

## Baseline Tasks

Seed these before steady-state operation:

- adapter proof on the default LLM adapter
- credential store verification without printing secrets
- wallet status/unlock proof
- AIBTC identity verification
- AIBTC heartbeat task with `requested_adapter: "aibtc-heartbeat"`
- operator runbook artifact covering recovery steps and known blockers

# Adapter Contracts

This file defines the current shared-runtime launch contract for every supported adapter.

The goal is simple:

- one runtime task contract
- one bundle/audit format
- one healthcheck surface
- small, explicit launch differences per adapter

## Trusted-VM Contract

`trusted-vm` means the adapter is running inside its own VM or otherwise isolated host where the operator intends full local filesystem and command access.

Required behavior:

- the runtime must pass the adapter's required bypass flags automatically
- the profile context should tell the model not to stop for routine permission prompts
- healthcheck must surface the required flags and any required host files
- proof tasks must verify real filesystem effects before reporting `completed`

Current required args by driver:

- `codex`: `--yolo`
- `claude-code`: `--allow-dangerously-skip-permissions --dangerously-skip-permissions --permission-mode bypassPermissions`
- `hermes-agent`: `--yolo`

## Driver Matrix

| Driver | Runtime adapter mode | Intended role today | Required host inputs | Required args in `trusted-vm` | Output handling |
| --- | --- | --- | --- | --- | --- |
| `codex` | `agent-cli` | repo edits, implementation, artifact-oriented tasks | command path, model/provider wiring, optional env file | `--yolo` | Codex `--output-last-message` file |
| `claude-code` | `agent-cli` | supervised operator/repo tasks with Claude CLI posture | command path, env file, settings file | `--allow-dangerously-skip-permissions --dangerously-skip-permissions --permission-mode bypassPermissions` | CLI JSON result payload |
| `hermes-agent` | `agent-cli` | terminal-heavy execution with Hermes tools | command path, model config in host Hermes setup | `--yolo` | `chat -Q` plus session-metadata stripping |
| `ollama-generate` | `ollama-generate` | proving-only raw model adapter | endpoint and model | none | raw JSON/text normalization |

## Host-Local Wiring

The repo-safe base config should stay portable. Host-specific command paths, env files, and settings files belong in a local config that `extends` the checked-in base config.

Recommended pattern:

- keep checked-in base config under `deploy/<agent>/runtime.<agent>.json`
- keep checked-in example override under `deploy/<agent>/runtime.<agent>.host.example.json`
- keep the live host override outside the synced repo tree if you deploy with `rsync --delete`

Example live override path on a host:

- `~/.config/agent-runtime/lumen.host.json`

Example `extends` target from that file:

- `"extends": "/home/dev/agent-runtime/deploy/lumen/runtime.lumen.json"`

That avoids deleting the real host override during repo syncs.

## Proof Status

As of 2026-04-23 on `dev@192.168.1.16`:

- `codex-ollama`: healthcheck-passing on Lumen proving runtime
- `claude-ollama`: minimal dispatch proof completed through runtime
- `hermes-ollama`: minimal dispatch proof completed through runtime after enabling quiet mode and Hermes-specific final-response extraction

This means the substrate is now proven for all three CLI-backed drivers on the Lumen host.

## Canonical Comparison Task

Before promoting a new agent VM or changing shared context rules, run the same small task through each adapter.

Canonical comparison properties:

- creates or verifies one disposable file under `/tmp`
- requires final JSON with `status`, `operator_summary`, `machine_status`, `file_changes`, `artifact_paths`, `follow_up_tasks`, `external_messages`
- uses explicit `requested_adapter`
- uses the same payload shape across all adapters
- writes no managed runtime artifacts unless the task explicitly asks for them

Evaluation points:

- did the task finish as `completed`
- did the adapter perform the real filesystem action claimed in `file_changes`
- did the final output normalize cleanly without transcript leakage
- what tool/use pattern differs by adapter
- what context or phrasing causes avoidable divergence

## Promotion Gate For A New Adapter Or VM

Do not treat a driver or new sibling VM as ready until all of these are true:

- `healthcheck` passes on the real host config
- one canonical comparison task completes cleanly
- one real task in that agent's intended domain completes cleanly
- audit bundle paths are present under `state/artifacts/adapter-runs/<task>/<attempt>/`
- the host-local launch contract is documented in the agent's deploy notes

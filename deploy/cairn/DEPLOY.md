# Cairn Deploy

Cairn is the first sibling-agent package scaffolded after Lumen.

This deploy is for clone-contract proof, not broad autonomy.

## Intended Role

Cairn is a read-mostly, artifact-writing agent focused on:

- runtime parity mapping
- deployment drift detection
- clone-readiness audits
- bounded rollout planning for sibling agents

## Recommended Host Shape

- working tree: `/home/dev/agent-runtime`
- base config: `/home/dev/agent-runtime/deploy/cairn/runtime.cairn.json`
- persistent host override: `~/.config/agent-runtime/cairn.host.json`
- state root: `/home/dev/agent-runtime/deploy/cairn/state`

## Bring-Up Steps

1. Clone or sync `agent-runtime` onto the new VM.
2. Run:
   - `cd /home/dev/agent-runtime`
   - `~/.bun/bin/bun install`
   - `~/.bun/bin/bunx tsc --noEmit`
   - `~/.bun/bin/bun test`
3. Create the host override:
   - `mkdir -p ~/.config/agent-runtime`
   - copy `deploy/cairn/runtime.cairn.host.example.json` to `~/.config/agent-runtime/cairn.host.json`
   - change its `extends` value to `/home/dev/agent-runtime/deploy/cairn/runtime.cairn.json`
   - edit real host-specific adapter paths and env/settings files
   - when local inference is down, start from `deploy/cairn/runtime.cairn.subscription.example.json` instead; it makes `codex-subscription` the only adapter and lets Codex CLI use its normal authenticated subscription/provider config from `~/.codex`
4. Run healthcheck on the config you intend to use:
   - `~/.bun/bin/bun run src/cli.ts healthcheck --config ~/.config/agent-runtime/cairn.host.json`

## First Proofs

Run these in order:

1. Canonical adapter proof on the default adapter.
2. One second adapter proof using an explicit `requested_adapter`.
3. One purpose task from `backlog/cairn.seed.json`.

Expected result:

- each proof completes with verified filesystem or managed-artifact evidence
- adapter audit bundles are written under `deploy/cairn/state/artifacts/adapter-runs/`
- Cairn leaves a durable artifact that improves clone readiness

## Package Files

- `deploy/cairn/IDENTITY.md`
- `deploy/cairn/PURPOSE.md`
- `deploy/cairn/runtime.cairn.json`
- `deploy/cairn/runtime.cairn.host.example.json`
- `deploy/cairn/runtime.cairn.subscription.example.json`
- `backlog/cairn.seed.json`

## Current Assumptions

These are provisional until the operator refines them:

- default adapter: `codex-ollama` for local inference, `codex-subscription` for subscription-backed proving
- operating mode: read-mostly, artifact-writing
- first mission: parity and clone-readiness mapping

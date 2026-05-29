# arc-starter (LEGACY — Loom's VM)

This arc-starter installation is **paused** and **read-only** as of 2026-05-28 per Proposal 0010 (Arc-Starter Migration Map) in `aibtcdev/agent-runtime/proposals/0010-arc-starter-migration.md`.

Loom's operational role has moved from "AIBTC publisher" to "Hermes-pair partner with Forge" under the agent-runtime kernel. The new runtime lives at `/home/dev/agent-runtime/` on this VM.

## Why this install is preserved

Loom ran as the AIBTC publisher for several months. The inscription workflow (`skills/daily-brief-inscribe/`) carries operational lessons that are still load-bearing for the fleet. Specifically, four patterns distilled into Proposal 0010's PRESERVE notes:

1. **Script-adapter-per-state** — each workflow state gets exactly one CLI command, one dispatched task. The agent does not reason about the workflow; it executes and exits.
2. **b64 cache trick** — large binary intermediates stored as filesystem-opaque artifacts. The LLM never reads them.
3. **AGENT.md prohibition block** — explicit "do not read X, do not poll inline, do not load brief content into context" lists.
4. **Brief-as-context-pollution** — workflow agents must never load the data payload they are orchestrating. This was the root cause of the token spiral (1.1–1.2M tokens/night).

## What is still alive

- `git` history — historical reference for migration work
- `memory/` — Loom's operational memory through the publisher era; cited by Proposal 0009 as seed material for the lessons layer
- `db/arc.sqlite` — Loom's task queue and cycle_log at the time of pause; useful for forensics and migration validation

## What is disabled

- `arc-dispatch.timer` — disabled at the systemd level
- `arc-sensors.timer` — disabled
- `arc-web.service` — disabled
- All `arc tasks add` writes — by convention, do not create new tasks here

## How to reach agent-runtime

Agent-runtime is installed at `/home/dev/agent-runtime/`. Loom's profile is at `deploy/loom/`. See `deploy/CLONE_CONTRACT.md` and `deploy/loom/DEPLOY.md` for the live runtime contract.

## Identity continuity

Loom's identity (BNS `loom0.btc`, BTC taproot, STX address, wallets) is unchanged. The same keys back agent-runtime. arc-starter's credential store remains intact for reference but is not the active source.

## Restoring this install

If for any reason agent-runtime needs to be backed out and Loom must return to arc-starter:

1. Stop the agent-runtime systemd units
2. Re-enable `arc-dispatch.timer`, `arc-sensors.timer`, `arc-web.service`
3. Run `arc status` to confirm the queue is intact
4. File the restore as a Mutation proposal in agent-runtime/proposals/

## Snapshot SHA

`<filled at handover>` — the arc-starter commit at the time of pause.

## Pointers

- agent-runtime install: `/home/dev/agent-runtime/`
- Loom's agent-runtime profile: `/home/dev/agent-runtime/deploy/loom/`
- Migration proposal: `aibtcdev/agent-runtime/proposals/0010-arc-starter-migration.md`
- Inscription-workflow lessons: same proposal, PRESERVE section
- Fleet readiness: `Genesis-Works/agent-coordination` fleet docs

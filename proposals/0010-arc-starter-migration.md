# Proposal 0010 - Arc-Starter Migration Map

State: draft
Class: Standard
Current implementation status: target-only

## Problem Statement

arc-starter is the production proof for autonomous agent operation: 41 days uptime on Arc's VM, 567 cycles last week, three peer-comms channels, four resilience layers, ~113 skills, a self-modifying memory layer that survives compression cycles. agent-runtime is the cleaner kernel: typed adapter boundary, evidence-bearing attempts table, bundle hashing for replay grading, first-class workflows and schedules.

The temptation is to port everything. The discipline is to port nothing that doesn't earn its way in. This proposal defines the migration delta with explicit PORT / ADAPT / LEGACY / PRESERVE classification for every arc-starter subsystem, plus a Loom-specific handover (Loom's VM repurposes from arc-starter publisher to agent-runtime Hermes-pair partner, with the existing install marked legacy via README).

The work this enables: the council can run agent-runtime as the canonical kernel; Arc continues serving production from arc-starter as the legacy hub; Loom transitions to Forge's pair without losing the inscription-workflow lessons; everything else either ports cleanly or stays on Arc's VM where it belongs.

## Current Behavior

- arc-starter is the only production hub. Five council VMs run agent-runtime at varying maturity (Lumen live; Spark/Forge/Cairn scaffolded; Iris placeholder).
- Loom's VM runs arc-starter, currently paused after the inscription-workflow token spiral. The publisher role is dormant.
- agent-runtime has no credential store, no worktree primitive, no MCP server skill, no memory layer, no resilience guards beyond the script adapter.
- arc-starter has all of the above but tightly coupled to Arc's identity (arc0.btc), payment infrastructure, and Claude Code dispatch.

## Proposed Change

Classify each arc-starter subsystem under one of four migration verbs and execute accordingly. Loom's VM gets a legacy README pinning its arc-starter install at the current commit, then a fresh agent-runtime install for Hermes-pair duty.

### Classification Table

| Subsystem | Verb | Rationale |
|-----------|------|-----------|
| `src/dispatch.ts` | ADAPT | Pattern moves (model gating, sandbox-failure detection, dispatch gate) but rewrites against agent-runtime's existing adapter dispatch + task_attempts. |
| `src/sensors.ts` | ADAPT | claimSensorRun → agent-runtime sensor_events producers. SQLite hook-state goes away. |
| `src/db.ts` schema | LEGACY (mostly) | `tasks`, `cycle_log`, `workflows` already in agent-runtime under cleaner names. `roundtable_*`, `consensus_*`, `market_positions`, `contribution_tags` stay on Arc. `task_deps`, `service_logs` ADAPT if missing. |
| `src/cli.ts` | LEGACY | `arc` CLI is tightly bound to Arc's SQLite, identity, and service topology. agent-runtime has its own operator surface. |
| `src/services.ts` | LEGACY | Cross-platform systemd installer is Arc-VM-specific; agent-runtime has `deploy/<agent>/` templates. |
| `src/web.ts` | LEGACY | x402-gated dashboard is Arc's monetization product. |
| `src/credentials.ts` | **PORT** | Encrypted credential store (AES-256-GCM + PBKDF2-SHA256) is a missing kernel primitive. Every council agent needs a secrets layer. |
| `memory/` content | PRESERVE | Don't port code. Extract: compression discipline (Proposal 0009), `dead-ends.md` schema, `shared/entries/` as seed Hermes onboarding docs. |
| `skills/` | mixed (see below) | Most are Arc-specific; small set are fleet-general primitives. |
| Resilience layers | ADAPT | Pre-commit syntax guard + post-commit health-check revert + sandbox-failure detection port as RFC-defined hooks; budget gate is replaced by agent-runtime's existing gate. |
| `templates/` | ADAPT | Prompt engineering artifacts move to agent-runtime templates layer. |
| `bin/arc` | LEGACY | Wrapper for Arc CLI. |
| SOUL.md / CLAUDE.md / MEMORY.md three-file context | PRESERVE | Doc the pattern in Hermes onboarding; don't port the file paths. |

### Skill Classification (113 skills, summarized)

**PORT (fleet-internal primitives, land in agent-runtime/skills):**

- `arc-worktrees` — git worktree isolation; missing kernel primitive
- `arc-mcp-server` — MCP server skill; carries fleet-shared dead-ends per Proposal 0009
- `arc-credentials` — companion to `src/credentials.ts` port
- `arc-peer-inbox` — agent-to-agent file inbox (pair with Proposal 0011 swarm protocol)

**ADAPT (rewrite against agent-runtime primitives, land in agent-runtime/skills):**

- `arc-workflows` + `state-machine.ts` — agent-runtime has workflows; harvest the script-adapter-per-state pattern and `max_transitions` guard discipline
- `contacts` — contact graph as MCP-served resource
- `arc-memory` — backs Proposal 0009 lessons layer
- `arc-scheduler` — agent-runtime has schedules; arc-scheduler patterns inform the layer
- `arc-skill-manager`, `arc-housekeeping` — operational hygiene patterns
- `daily-brief-inscribe` — PRESERVE pattern (see below), ADAPT skill structure to Proposal 0008 contract

**LEGACY (stays on Arc's VM, never ports):**

- `arc0btc-*` (pr-review, ask-service, monetization, security-audit, services, site-health) — Arc identity products
- `aibtc-*` (agent-trading, dev-ops, heartbeat, inbox-sync, news-*, repo-maintenance, welcome) — AIBTC publisher surface, much of it now paused
- `erc8004-*`, `wot`, `arc-reputation`, `identity-guard` — Arc's trust graph; council agents register independently
- `arc-payments`, `arc0btc-monetization` — payment infrastructure tied to arc0.btc
- `arc-ceo-review`, `arc-strategy-review`, `arc-purpose-eval`, `arc-self-*`, `arc-introspection`, `arc-brand-voice` — Arc's identity/governance loop
- `arc-cost-reporting`, `arc-performance-analytics`, `arc-reporting`, `arc-report-email`, `arc-weekly-presentation` — Arc's ops reporting

**PRESERVE (extract lessons, don't port code):**

- `daily-brief-inscribe` — RFC-able lessons from Loom's inscription work:
  1. **Script-adapter-per-state**: each workflow state gets exactly one CLI command, one dispatched task. Agent does not reason about the workflow.
  2. **b64 cache trick**: large binary intermediates stored as filesystem-opaque artifacts; LLM never reads them.
  3. **AGENT.md prohibition block**: explicit "do not read X, do not poll inline, do not load brief content into context" lists.
  4. **Brief-as-context-pollution lesson**: workflow agents must never load the data payload they are orchestrating. Token spiral root cause.

### Loom VM Handover

1. Snapshot the current arc-starter install on Loom's VM at the current SHA (preserve git history, commit any uncommitted state).
2. Write `/home/dev/arc-starter/README.LEGACY.md` on Loom marking the install as paused at the snapshotted SHA, with pointers to:
   - The agent-runtime install (when present)
   - The inscription-workflow lessons distilled into Proposal 0010 PRESERVE notes
   - The recent.log and memory/ artifacts as historical reference
3. Install agent-runtime under `/home/dev/agent-runtime/` (or similar) per the clone contract.
4. Configure Loom's runtime profile as Forge's Hermes-pair partner: `hermes-openrouter` adapter, A/B variant against Forge per Proposal 0012 (pair charter, deferred).
5. arc-starter timers on Loom (`arc-dispatch`, `arc-sensors`, `arc-web`) remain disabled. arc-starter install is read-only reference.

## What This Removes

- The assumption that arc-starter must port wholesale to agent-runtime
- The risk of porting Arc's identity products into a fleet kernel
- The Loom publisher role as an active workload (it's been paused for weeks; this formalizes the handover)
- Ambiguity about which arc-starter skill primitives the fleet inherits

## Invariants

1. PORT and ADAPT subsystems MUST land via separate, individually-rollbackable proposals (each is a Mutation-class follow-up to this Standard proposal).
2. LEGACY subsystems MUST NOT be ported. If a council agent needs equivalent functionality, file a new proposal — do not lift Arc's implementation.
3. PRESERVE artifacts (memory content, inscription lessons) MUST be cited in onboarding docs and where relevant in the proposals/ lane. The arc-starter code stays on Arc's VM as the authoritative copy.
4. Loom's arc-starter install MUST be marked legacy via README before the agent-runtime install activates.
5. arc-starter and agent-runtime MUST NOT share a SQLite database on Loom's VM. Separate `state/` directories per runtime.
6. Loom's BNS, BTC, STX addresses MUST NOT change during handover. Identity continuity.

## Rollback Anchor

The current state is the rollback anchor: arc-starter is the only production runtime; Loom's install is paused but intact; agent-runtime has Lumen live and three scaffolded peers.

Rollback steps:
- Loom: re-enable arc-starter timers; disable agent-runtime install.
- agent-runtime: each PORT/ADAPT subsystem rolls back independently.
- PRESERVE notes remain as documentation regardless.

## Success Criteria For "Observed" -> "Amended Or Retired"

- 4 PORT skills land in agent-runtime under Proposal 0008 contract
- 5 ADAPT subsystems are rewritten and shipped (each as a separate Mutation proposal)
- Loom's arc-starter install is README-pinned and agent-runtime is operational on her VM
- Loom executes a non-trivial task under hermes-openrouter adapter and matches Forge's output on at least one A/B case
- Inscription-workflow lessons cited in at least one downstream proposal (e.g., a future workflow proposal for content publishing)

## Task Class

`runtime-migration`

## Variant Strategy

Phased. Each PORT and ADAPT subsystem is independently rollbackable. Loom handover is single-VM, single-pass.

## Routing Policy At Launch

- Phase 1: Loom handover (README, snapshot, agent-runtime install).
- Phase 2: PORT subsystems (credentials, arc-worktrees, arc-mcp-server, arc-peer-inbox).
- Phase 3: ADAPT subsystems (memory layer per Proposal 0009; workflow patterns; contact graph; resilience guards).
- LEGACY and PRESERVE are documentation tasks, run in parallel with Phase 1–3.

## Budget Ceiling

- Loom handover: 1 dispatch cycle on Loom + 1 cycle on Arc for snapshot tooling
- PORT subsystem: 3 cycles per subsystem (port + test + integrate)
- ADAPT subsystem: 5 cycles per subsystem (more rewrite than port)
- PRESERVE: 1 cycle per artifact (documentation)

## Target State

agent-runtime ships the 4 PORT primitives. The 5 ADAPT subsystems are rewritten against agent-runtime's existing adapter, workflow, schedule, and sensor_events primitives. Loom is online under agent-runtime as Forge's Hermes-pair partner; her arc-starter install is README-pinned legacy. Arc continues running arc-starter as the production hub with no migration pressure.

## Schema Changes

None at the proposal level. Per-subsystem proposals declare their own schema changes (verification_cmd in 0007; memory layer in 0009).

## Runtime Changes

Per-subsystem proposals declare their own runtime changes. This proposal is the routing artifact.

## Migration / Backfill

Loom-specific only. No backfill for other agents.

## Tests

1. Loom snapshot tooling preserves arc-starter git history
2. Loom README.LEGACY.md exists and is reachable from the agent-runtime install
3. Each PORT subsystem lands with its own test suite per its sub-proposal
4. Each ADAPT subsystem ships with a regression test against the arc-starter behavior it replaces
5. Cross-runtime isolation: agent-runtime and arc-starter on Loom's VM do not share `state/` directories
6. A/B test fixture: at least one task dispatched to both Forge and Loom produces comparable CanonicalOutcomes within tolerance

## Observability

- Loom handover artifacts: snapshot SHA, README.LEGACY.md, agent-runtime profile JSON, all linked from agent-coordination fleet-readiness doc
- Per-subsystem observability per sub-proposal
- Migration progress dashboard (operator UI extension)

## Acceptance Gate

Phase 1 (Loom handover) acceptance: README-pinned legacy install + agent-runtime operational + one task executed under hermes-openrouter.

Phase 2 (PORT) acceptance: 4 reference primitives live in agent-runtime/skills under Proposal 0008 contract.

Phase 3 (ADAPT) acceptance: 5 subsystems shipped, each with its own observed-stable window.

## Rollback

- Loom: re-enable arc-starter timers on her VM; deactivate agent-runtime.
- Each PORT/ADAPT subsystem: independent rollback per its sub-proposal.
- PRESERVE notes remain as documentation regardless of rollback status.

## One-Line Gates

- Delete gate — wholesale-port-of-arc-starter assumption deleted in favor of explicit classification
- Merge gate — this routing proposal accepted; per-subsystem proposals begin landing
- Runtime gate — Loom Phase 1 handover complete; agent-runtime operational on her VM
- Observation gate — 4 PORT skills + 5 ADAPT subsystems shipped with stable observation windows
- Promotion gate — Loom A/B test with Forge produces matching CanonicalOutcomes; pair is operational

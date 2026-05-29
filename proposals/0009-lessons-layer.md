# Proposal 0009 - Lessons Layer

State: draft
Class: Standard
Current implementation status: target-only

## Problem Statement

Across the autoresearch corpus surveyed (Karpathy, codex-autoresearch, uditgoenka, kayba-ai/recursive-improve), three persistence tiers consistently emerge: state (the task queue), audit (cycle/event log), and **lessons** (machine-written, per-goal-family, capped, time-decayed, consulted at hypothesis-generation time).

agent-runtime has state and audit. It does not have lessons.

In a six-VM fleet, the absence of a lessons layer means every VM re-learns failures already discovered by a sibling agent. Cairn rediscovers an OpenRouter rate-limit quirk that Forge solved last week. Spark re-tries a Claude Code adapter configuration that Lumen documented as a dead-end. The fleet runs in parallel but not multiplicatively.

Arc-starter's `memory/MEMORY.md` + `memory/patterns.md` + `memory/dead-ends.md` + `memory/recent.log` is the production proof that this layer is load-bearing. The compression discipline (append → monthly consolidate → commit) is workable but human-curated. For a six-VM fleet, the writes need to be machine-emitted, the reads need to be fast, and the consolidation needs to be a workflow.

## Current Behavior

- `agent-runtime`: no `memory/` directory, no lessons artifact, no dead-ends registry. `run_events` is the closest analog but it's per-event audit, not synthesized learning.
- `arc-starter`: production proof; `memory/MEMORY.md` (~180 lines), `memory/patterns.md` (~27 entries capped at 150 lines), `memory/dead-ends.md` (anti-patterns), `memory/recent.log` (per-task one-liner reflection). Human-curated. Loaded into every dispatch.
- No cross-agent sharing of lessons. Each agent is an island.

## Proposed Change

Introduce a three-file lessons layer per agent runtime, plus a fleet-shared dead-ends registry served via Arc's existing arc-mcp-server.

### Per-Agent Lessons Files

```
memory/
├── MEMORY.md                 # compressed operational memory; identity + active items
├── patterns/                 # validated patterns by goal-family
│   ├── <family>.md           # e.g., dispatch.md, skills.md, adapters.md
│   └── ...
├── dead-ends.jsonl           # append-only; anti-patterns; what NOT to retry
└── recent.log                # per-task one-line reflection (Arc's pattern)
```

### Fleet-Shared Dead-Ends (via arc-mcp-server)

Two new MCP tools exposed by arc-mcp-server (already running on Arc's VM):

- `dead_ends.read(family?, since?)` — returns recent dead-end entries, optionally filtered by goal-family or timestamp
- `dead_ends.write(entry)` — append a new entry; tagged with originating agent

Each council agent's lessons layer reads from this shared registry before generating new hypotheses (research mode) or selecting retry strategies (escalation ladder).

### Lesson Entry Schema

```jsonl
{"ts":"2026-05-28T15:00:00Z","family":"dispatch","agent":"forge","topic":"hermes-openrouter rate limit","approach":"exponential backoff 1s/2s/4s","outcome":"insufficient — 429 persists past 8s","why_failed":"OpenRouter free tier has 60s cooldown not 8s","next_try":"use paid tier or 90s backoff floor"}
```

### Consolidation Workflow

Monthly consolidation runs as a scheduled task: `lesson-consolidate` workflow reads recent.log + dead-ends.jsonl, proposes additions to patterns/<family>.md, and opens a PR for operator review. The workflow IS a council-reviewable artifact, not a silent write.

## What This Removes

- The pattern of each VM rediscovering known failures
- Unstructured memory writes (Arc's append-to-MEMORY.md is human-discipline, not enforceable)
- The need for whoabuddy to manually consolidate patterns into MEMORY.md
- The expectation that retrospective happens "eventually" — it happens on a schedule with a queue task

## Invariants

1. Every task close MUST append one line to `memory/recent.log` (Arc's pattern, enforced at runtime).
2. Every `retryable_failure` or `permanent_failure` MUST optionally write a `dead-ends.jsonl` entry. Optional because not every failure is a lesson, but the surface MUST exist.
3. Patterns/<family>.md files MUST be capped at 150 lines. Overflow triggers a consolidation task.
4. Dead-ends entries are append-only. Stale or wrong entries are marked `superseded_by:<ts>` not deleted.
5. The fleet-shared dead_ends MCP surface MUST authenticate (BIP-322 or BIP-137 per existing arc-mcp-server contract); council agents MUST register their identity.
6. The consolidation workflow MUST produce a PR, never a direct commit to patterns/.
7. Lessons-layer reads MUST be allowed without write capability (read-only tokens for non-council MCP clients).

## Rollback Anchor

The current state is the rollback anchor: no lessons layer in agent-runtime, no fleet-shared dead-ends, Arc's memory/ as human-only. Rollback is trivial — stop writing to memory/, leave existing files alone.

## Success Criteria For "Observed" -> "Amended Or Retired"

- `memory/` directory standard across all council agents
- `dead_ends.jsonl` has ≥50 entries within 30 days of acceptance
- At least one observed instance of a council agent reading a sibling's dead-end and avoiding the same failure
- Monthly consolidation workflow produces a PR that whoabuddy accepts
- recent.log lines provide per-task reflection that is referenced in the eval harness

## Task Class

`runtime-memory`

## Variant Strategy

Single.

## Routing Policy At Launch

- Phase 1: Per-agent memory/ layout lands; recent.log + dead-ends.jsonl writes enforced.
- Phase 2: Fleet-shared dead_ends MCP tools land on Arc's arc-mcp-server.
- Phase 3: Monthly consolidation workflow lands.

## Budget Ceiling

- Per-task lesson write: $0 (mechanical append)
- Monthly consolidation: $5 ceiling (LLM-assisted patterns synthesis)
- MCP read: $0

## Target State

Every council agent has a memory/ layout with machine-emitted writes. Fleet-shared dead-ends consulted before hypothesis-generation in research mode and before retry-strategy selection in the escalation ladder. Monthly consolidation produces durable patterns/<family>.md files that compress the audit log into actionable rules.

## Schema Changes

No DB schema changes. File-backed.

Optional: `tasks.lesson_topic TEXT` column for tagging tasks to a goal-family at creation time, to make per-family lesson queries faster.

## Runtime Changes

- `src/runtime.ts`: on task close, append to recent.log; on failure, surface dead-ends.jsonl write affordance to adapter.
- `src/memory.ts`: new — reads patterns/<family>.md and dead-ends.jsonl into the bundle compilation step.
- `src/context.ts`: bundle compilation includes recent lessons (last 7 days, family-filtered) and dead-ends (family-filtered) when the task declares a `lesson_topic`.
- arc-starter side: `arc-mcp-server` skill gains two tools, `dead_ends_read` + `dead_ends_write` (skill contract per Proposal 0008; PORT classification per Proposal 0010).
- New workflow: `lesson-consolidate` runs monthly, dispatches a sonnet task that proposes patterns/ updates as a PR.

## Migration / Backfill

- Phase 1 launch with empty memory/ on all council agents except Arc.
- Arc's existing memory/MEMORY.md + patterns.md + dead-ends.md remain canonical and seed the fleet-shared registry.
- aibtcdev/skills/arc-memory skill (port from arc-starter) handles the bookkeeping.

## Tests

1. recent.log append on task close
2. dead-ends.jsonl append on failure (when adapter opts in)
3. patterns/<family>.md cap at 150 lines triggers consolidation task
4. Bundle compilation includes recent lessons when task has lesson_topic
5. Fleet-shared dead_ends MCP tools authenticate correctly (BIP-322/BIP-137)
6. Read-only MCP clients can fetch dead-ends but not write
7. Consolidation workflow produces a PR, not a direct commit

## Observability

- `lesson_written` event in run_events for every recent.log append
- `dead_end_referenced` event when bundle compilation includes a dead-end
- Monthly consolidation PR is the artifact

## Acceptance Gate

Phase 1: memory/ layout standard, recent.log + dead-ends.jsonl writes operational on all council agents.

Phase 2: arc-mcp-server exposes dead_ends tools, council agents read before hypothesis-generation.

Phase 3: at least one monthly consolidation PR accepted by operator.

## Rollback

Phase 1: stop enforcing recent.log writes. Files remain as historical artifacts.

Phase 2: disable MCP tools. Per-agent lessons continue.

Phase 3: skip consolidation workflow; patterns/ remain manually-curated.

## One-Line Gates

- Delete gate — per-VM rediscovery of known failures deleted in favor of fleet-shared lessons
- Merge gate — memory/ layout + recent.log + dead-ends.jsonl writes land on Lumen as the first proving agent
- Runtime gate — bundle compilation includes lessons when task declares lesson_topic
- Observation gate — ≥50 dead-end entries and ≥1 observed cross-agent dead-end avoidance in 30-day window
- Promotion gate — monthly consolidation workflow lands and produces an accepted PR

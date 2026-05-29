# Proposal 0008 - Cross-Harness Skill Contract

State: draft
Class: Constitutional
Current implementation status: target-only

## Problem Statement

A six-VM fleet running three harnesses (Claude Code, Codex CLI, Hermes Agent) cannot share skills if each harness interprets skill files differently. Arc-starter's `skills/<name>/{SKILL.md,AGENT.md,sensor.ts,cli.ts}` layout works because every dispatched session is Claude Code. agent-runtime explicitly does not have that assumption — adapters are swappable, and the same task on Forge (hermes-openrouter) must execute the "same" skill as on Spark (claude-subscription).

The good news: the convergence already exists. **agentskills.io** is the de facto open standard published by Anthropic in December 2025 and adopted by Claude Code, Codex CLI, Cursor, Gemini CLI, GitHub Copilot, and VS Code. **microsoft/waza** ships a Go CLI that scaffolds, runs, and grades skill evals against a YAML schema. **microsoft/SkillOpt** ships a training loop that grows skill documents like neural weights via Rollout → Reflect → Aggregate → Select → Update → Gate. **aibtcdev/skills** has Arc's existing metadata extensions.

This proposal converges all four into a harness-agnostic skill contract that every council agent can load, every adapter can interpret, and that compiles into existing skill ecosystems (Anthropic Skills, Claude Code plugin marketplace).

## Current Behavior

- `aibtcdev/skills`: `<name>/SKILL.md` with `metadata.entry`, `metadata.requires`, `metadata.tags`, `metadata.author-agent`. Not aligned with agentskills.io. No `AGENT.md` or `sensor.ts` convention. Doc-only and TS-backed skills mixed.
- `arc-starter/skills`: `<name>/{SKILL.md,AGENT.md,sensor.ts,cli.ts}` — richer but Claude-Code-coupled.
- `agent-runtime`: no skill discovery primitive. Skills are profile-tagged via `profiles/<agent>/profile.json` and bundle-compiled per task. No eval harness. No growth loop.

## Proposed Change

Define a single skill directory layout that satisfies agentskills.io as the base, accommodates Arc/Notch extensions via `metadata.*`, and ships with an eval contract borrowed from waza and a growth contract borrowed from SkillOpt.

### Skill Directory Contract

```
skills/<skill-name>/
├── SKILL.md              # required; agentskills.io frontmatter + orchestrator body
├── AGENT.md              # optional; subagent execution briefing (Notch extension)
├── sensor.ts             # optional; autonomous trigger (Notch extension)
├── cli.ts                # optional; action surface for adapters that expose CLI (Notch extension)
├── scripts/              # optional; agentskills.io standard; executable helpers
├── references/           # optional; agentskills.io standard; pull-on-demand docs
├── assets/               # optional; agentskills.io standard; templates/fixtures
└── evals/                # optional; waza-compatible eval harness
    ├── eval.yaml         # waza schema
    ├── tasks/*.yaml      # individual eval cases
    └── fixtures/         # eval inputs
```

### Frontmatter Contract (agentskills.io base + Notch extensions)

```yaml
---
name: skill-name                         # required; 1-64 chars; lowercase + hyphens; matches dir
description: "what + when"               # required; 1-1024 chars
license: Apache-2.0                      # optional; standard
compatibility: "bun >=1.1, stacks-node"  # optional; ≤500 chars
allowed-tools: "Bash(git:*) Read"        # optional; agentskills.io experimental field
metadata:
  version: "1.0.0"                       # required for Notch; semver
  author: "agent-or-org"                 # optional
  author-agent: "Forge"                  # optional; Notch agent identity
  user-invocable: false                  # optional; Notch field
  agent-briefing: AGENT.md               # optional; Notch extension; subagent doc
  sensor: sensor.ts                      # optional; Notch extension; autonomous trigger
  cli: cli.ts                            # optional; Notch extension; action surface
  requires: "wallet, signing"            # optional; Notch field; resource requirements
  tags: "l2, write, infrastructure"      # optional; Notch field; routing tags
  harness-affinity: "claude-code,codex"  # optional; Notch extension; preferred harnesses
  verification_cmd_template: "bun test"  # optional; Proposal 0007 hook
---
```

Notch extensions live entirely under `metadata.*` so non-Notch harnesses ignore them silently per agentskills.io spec.

### Eval Contract (waza schema)

```yaml
# evals/eval.yaml
name: skill-name
skill: ../SKILL.md
version: "1.0.0"
executor: claude-code                    # mock | claude-code | codex | hermes-agent
thresholds:
  shippable: 0.90
  needs_work: 0.70
tasks:
  - id: golden-case-1
    prompt: "..."
    expected: "..."
    validators:
      - type: text
        regex_match: "..."
      - type: code
        run: "bun test tests/golden-1.test.ts"
        expected_exit: 0
```

### Growth Loop (SkillOpt-inspired)

Skills MAY opt into a growth loop. The loop runs in a separate worktree (Arc's `arc-worktrees` pattern, ported per Proposal 0010):

1. **Rollout** — run all eval tasks against current SKILL.md, capture trajectories
2. **Reflect** — optimizer model proposes `add`/`delete`/`replace` patches to SKILL.md
3. **Aggregate** — semantically similar patches merged
4. **Select** — patches ranked, clipped by learning rate
5. **Update** — patches applied
6. **Gate** — re-run evals on held-out split; reject if shippable threshold drops

The growth loop is a Notch extension. SkillOpt's `best_skill.md` evolution maps onto `SKILL.md` directly. Failed gates produce a `dead_end` entry under Proposal 0009.

## What This Removes

- The implicit assumption that skills are Claude-Code-shaped
- Arc's bespoke skill loader (`discoverSkills()`) as the only path to find skills
- The need to author a new skill format per harness
- Doc-only vs code-backed skill divergence — both fit the agentskills.io shape
- The lack of a skill-level eval harness — waza provides it

## Invariants

1. Every skill MUST have a SKILL.md with `name` + `description` frontmatter (agentskills.io required fields).
2. The skill directory name MUST match `metadata.name`.
3. Notch-specific extensions MUST live under `metadata.*` so non-Notch harnesses ignore them gracefully.
4. Skills with a growth loop MUST have an `evals/` directory with at least 5 task cases.
5. SKILL.md body MUST NOT assume a specific harness — no "use the Read tool" or "use bash". Skills MAY reference adapter-portable verbs ("read the file at X", "run the command Y") and MAY use `allowed-tools` to declare needed primitives.
6. `metadata.harness-affinity` MAY restrict which adapters dispatch the skill, but MUST NOT be a hard gate at the runtime — affinity is routing preference, not capability assertion.
7. `metadata.verification_cmd_template` MUST be a self-contained command per Proposal 0007 invariants (no shell composition; scripts go in `scripts/`).
8. Skill versions MUST follow semver. Breaking SKILL.md changes bump major.

## Rollback Anchor

The current state is the rollback anchor: aibtcdev/skills's existing format, Arc's discoverSkills(), no eval harness. Rollback is operationally trivial — delete the new contract doc, leave existing skills in place.

## Success Criteria For "Observed" -> "Amended Or Retired"

- 5 reference skills land in agent-runtime with the new contract (kernel-internal: `arc-mcp-server`, `arc-credentials`, `arc-worktrees`, `arc-peer-inbox`, `contacts`)
- Each reference skill has `evals/eval.yaml` with ≥5 task cases
- `waza check` integration runs in CI on every skill change
- At least one skill executes successfully under each of: claude-code, codex, hermes-agent adapter
- At least one growth-loop cycle completes on a non-critical skill (probably `contacts`) producing a measurable eval improvement
- aibtcdev/skills migrates 10 highest-traffic skills to the new contract within 30 days of acceptance

## Task Class

`runtime-skills`

## Variant Strategy

Single. Convergence on the agentskills.io base; Notch extensions are additive.

## Routing Policy At Launch

- Phase 1: Reference implementation (5 skills) lands in agent-runtime under the new contract; no aibtcdev/skills migration yet.
- Phase 2: waza CI gate added to aibtcdev/skills PRs; new skills MUST conform.
- Phase 3: existing aibtcdev/skills migrate one beat at a time.

## Budget Ceiling

- Implementation tick budget: 5 dispatch cycles per reference skill landing
- Eval execution budget: $0.10/skill per growth-loop cycle (waza tasks are deterministic)
- Reflect-step model budget: $0.50/skill per growth cycle (SkillOpt optimizer)

## Target State

agent-runtime ships a `skills/` directory under the agentskills.io standard with Notch extensions for AGENT.md, sensor.ts, cli.ts. Every skill has a SKILL.md and (where applicable) an evals/ directory. `waza check` runs in CI. Skill growth is an opt-in primitive available to council agents.

aibtcdev/skills converges onto the same standard, becoming the public registry. The 5 fleet-internal skills live in agent-runtime; everything domain-specific lives in aibtcdev/skills under the same contract.

## Schema Changes

None in the runtime DB.

File convention additions:

- `agent-runtime/skills/<name>/SKILL.md` (+ optional standard dirs)
- `agent-runtime/skills/<name>/evals/eval.yaml` (waza schema)
- `aibtcdev/skills/<name>/...` adopts the same convention

## Runtime Changes

- `src/skills.ts`: skill discovery walks `skills/*/SKILL.md`, parses frontmatter via existing YAML lib, returns SkillDescriptor.
- `src/context.ts`: bundle compilation reads SKILL.md body for orchestrator context; AGENT.md (if present) passed as subagent briefing only.
- `src/sensors.ts`: skill sensors discovered via `metadata.sensor` path; same `claimSensorRun` interval gate as arc-starter.
- New: `src/skill-evals.ts` — shell out to `waza check skills/<name>` for eval gating.

## Migration / Backfill

- Phase 1: 5 fleet-internal reference skills authored fresh under the new contract.
- Phase 2: aibtcdev/skills CI gate (no immediate backfill; new skills only).
- Phase 3: top-10 traffic skills migrated; each migration is a separate Mutation proposal.

## Tests

Required before Phase 1 merge:

1. SKILL.md parser accepts agentskills.io required fields
2. SKILL.md parser rejects skills with name mismatch (dir name vs `metadata.name`)
3. `metadata.*` extensions parse without breaking non-Notch consumption (verify by passing skill through anthropics/skills loader)
4. `waza check` runs against each reference skill and exits 0
5. Skill sensor file at `metadata.sensor` path is discovered by sensor service
6. Skill that opts into growth loop has ≥5 eval tasks (lint rule)
7. Skill execution under each adapter produces a valid CanonicalOutcome
8. Cross-harness lint: SKILL.md body containing the strings "use the Read tool", "use bash", "open the file" is flagged for harness-specific language

## Observability

- `skill_loaded` event in run_events for every skill referenced in a task bundle
- Operator UI shows skill version per attempt
- `skill_eval_pass_rate` rollup per skill per day
- Growth-loop trajectory artifacts under `state/skill-growth/<skill>/<run_id>/`

## Acceptance Gate

Phase 1: 5 reference skills land, all pass `waza check`, each executes under at least one adapter.

Phase 2: aibtcdev/skills CI rejects PRs that violate the contract.

Phase 3: ≥10 aibtcdev/skills migrated; 7-day observed stability.

## Rollback

Phase 1 rollback: remove reference skills, no kernel changes affected (skill discovery is additive).

Phase 2 rollback: disable waza CI gate; existing skills continue.

Phase 3 rollback: each migration is independently reversible because skills are versioned.

## One-Line Gates

- Delete gate — Claude-Code-shaped-skill assumption deleted in favor of agentskills.io base
- Merge gate — 5 reference skills land under the new contract with passing waza evals
- Runtime gate — skill discovery, sensor wiring, eval gating live in agent-runtime
- Observation gate — at least one skill executes successfully under each of claude-code, codex, hermes-agent adapters
- Promotion gate — aibtcdev/skills CI adopts the contract; top-10 migration begins

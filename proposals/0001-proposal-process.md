# Proposal 0001 - Proposal Process

State: draft
Class: Standard
Current implementation status: target-only

## Problem Statement

`agent-runtime` now has a normative planning document, but it still lacks the concrete proposal lane that turns design intent into implementation gates. Without proposal files, build scope can expand silently, schema changes can be introduced without rollback language, and later proposals can pretend prerequisites are settled when they are not.

This proposal establishes the governance substrate for the first implementation tranche. Until Proposal `0002` is implemented and observed, the active build scope MUST remain limited to:

- `0001` proposal process
- `0002` execution record (merged attempt + bundle, with boot-sweep crash recovery)
- `0003` mutation-class sensor fix, if it stays single-surface and does not add primitives

Everything `0004+` is explicitly out of scope for the first build tranche except for drafting.

An earlier draft of this proposal referenced separate `0002` (bundle artifact) and `0002.5` (execution substrate) files. Review consolidated those into a single `0002 — Execution Record` because their schemas and lifecycles are inseparable. The first-tranche scope is correspondingly narrower.

## Current Behavior

- The runtime persists only task/workflow execution state. `openDb()` creates `tasks`, `run_events`, and `workflows`; there is no proposal artifact, registry, or governance table in local code today. See `agent-runtime/src/db.ts:8-53`.
- `runOnce()` consumes tasks directly from the queue and executes them with no proposal gate, proposal identifier, or proposal-derived acceptance criterion. See `agent-runtime/src/runtime.ts:22-145`.
- The runtime already has an empty `plans/` directory but no proposal lane or proposal files. The planning contract exists in the root planning doc, not as an engine-adjacent workflow artifact.
- The planning document now requires proposal classes, gates, dependency order, and RFC 2119 language, but those requirements are not yet materialized as first-class files the implementation can reference.

## Proposed Change

Create `agent-runtime/proposals/` as the canonical proposal lane and require every non-Mutation implementation change to begin from a numbered proposal file in that directory.

This proposal defines:

- proposal numbering and naming convention: `NNNN-short-title.md`
- mandatory sections for every proposal
- proposal classes: `Mutation`, `Standard`, `Constitutional`
- state machine: `draft -> discussed -> accepted -> implemented -> observed -> amended | retired`
- one-line gates that must appear at the end of every proposal
- first-tranche scope lock: `0001`, `0002`, optional `0003`

This proposal does not create a runtime DB table for proposals yet. File-backed governance is enough for the first build tranche. If proposal state later needs to drive UI or automation, that can be introduced by a later proposal after the file contract is proven useful.

## What This Removes

- Ad hoc design changes that start as chat and skip a durable proposal artifact
- Scope creep during the first build tranche
- Ambiguous "we can do that later" language for schema, migration, tests, and rollback
- The need to restate proposal process rules in each future design note

## Invariants

1. Every `Standard` or `Constitutional` runtime change MUST have a proposal file in `agent-runtime/proposals/` before implementation starts.
2. Every proposal file MUST declare `State`, `Class`, and `Current implementation status` near the top.
3. Every proposal file MUST include the required sections from the planning document: current behavior, proposed change, what this removes, invariants, rollback anchor, task class, variant strategy, routing policy, budget ceiling, schema changes, runtime changes, migration/backfill, tests, observability, acceptance gate, and rollback.
4. The first build tranche MUST NOT implement `0004+` features before `0002` is implemented and observed.
5. Mutation-class changes MAY use a shorter file, but MUST still record scope, invariants, tests, and rollback.
6. Constitutional proposals MUST receive explicit operator review before merge.
7. Proposal files are the source of truth for implementation sequencing. If code or planning notes disagree with an accepted proposal, the proposal wins until amended.
8. A proposal MUST name what it deletes before it adds optimization or automation.

## Rollback Anchor

The rollback anchor is the current file layout and direct implementation flow:

- no `agent-runtime/proposals/` dependency in runtime code
- direct queue execution in `agent-runtime/src/runtime.ts`
- no proposal-derived UI or DB state

Because this proposal is file-backed only, rollback is operationally trivial: stop requiring proposal files for new work and mark this proposal `retired`.

## Success Criteria For "Observed" -> "Amended Or Retired"

- Proposals `0001` and `0002` exist in `agent-runtime/proposals/` and contain all mandatory sections.
- The first implementation PR for attempts and bundles cites `0002` directly.
- No first-tranche PR introduces `0004+` behavior without an accepted amendment to this proposal.
- Reviewers can determine scope, tests, migration, and rollback by reading the proposal file alone.

## Task Class

`runtime-governance`

## Variant Strategy

Single

## Routing Policy At Launch

Production

## Budget Ceiling

- Max ticks: 1 docs task per proposal draft
- Max variants: 1
- Max spend per tick: local-doc-only

## Target State

After this proposal lands, `agent-runtime/proposals/` exists as a stable file-backed governance lane, the first build tranche is explicitly bounded, and implementation may start only from drafted proposal files rather than from the planning document alone.

## Schema Changes

None in runtime storage for the first tranche.

File convention added:

- `agent-runtime/proposals/NNNN-short-title.md`

## Runtime Changes

- Create `agent-runtime/proposals/`
- Store the first tranche proposals in that directory
- Require future implementation work to cite proposal IDs in commit messages, PR descriptions, or execution artifacts

No runtime engine code changes are required for `0001`.

## Migration / Backfill

- No DB migration
- No artifact migration
- Existing planning notes remain historical context and do not need renaming
- The first tranche begins by drafting `0001` and `0002`; no backfill is attempted for older ad hoc design chats

## Tests

No runtime unit tests are required because this proposal is file-backed governance only. Required checks before merge:

1. `test -f agent-runtime/proposals/0001-proposal-process.md`
2. `test -f agent-runtime/proposals/0002-execution-record.md`
3. `rg -n "^## " agent-runtime/proposals/0001-proposal-process.md agent-runtime/proposals/0002-execution-record.md`
4. Manual review confirms each file contains all mandatory sections and the first-tranche scope lock

## Observability

- Proposal files themselves are the observability artifact for `0001`
- Future implementation PRs should reference proposal IDs explicitly
- Review comments should cite proposal section names when requesting changes

## Acceptance Gate

`0001` is accepted when the proposal directory exists, `0001` and `0002` exist with complete sections, any shipped `0003` mutation file also exists with complete sections, and implementation can start from those files without another design rewrite.

## Rollback

- Stop requiring new changes to begin from proposal files
- Mark `0001` as `retired`
- Leave existing proposal files on disk as historical artifacts

Rollback does not require DB or runtime changes because this proposal adds only file-backed governance.

## One-Line Gates

- Delete gate - ad hoc first-tranche design process deleted in favor of numbered proposal files
- Merge gate - `0001` and `0002` files exist and are reviewed
- Runtime gate - implementation work references these proposal files directly
- Observation gate - first implementation PRs follow the bounded tranche without scope creep
- Promotion gate - execution-record coding may begin

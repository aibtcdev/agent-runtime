# Proposal 0007 - Verification Gate

State: draft
Class: Constitutional
Current implementation status: target-only

## Problem Statement

The runtime currently accepts `completed` as a self-asserted outcome. An adapter returns a CanonicalOutcome blob, `runtime.ts` records it, the task moves to `completed`, and the next task downstream depends on that claim. There is no mechanical check between "the agent said it was done" and "the runtime believed it."

This is the single highest-leverage gap identified across the harness engineering research (`harness-engineering-completion-verification.md`; walkinglabs lectures 7–10 all converge here). Self-evaluation bias is documented (Anthropic 2026, Guo et al. 2017). In a single-agent context this manifests as silent regressions. In a six-VM fleet it compounds: VM-A marks task complete, VM-B depends on it, VM-B fails on bad output, and the failure attribution is buried two cycles back.

The arc-starter post-commit service-health revert is a partial fix at the commit boundary but it does not generalize to non-code tasks (signal filing, inscription state transitions, payout reconciliation), and it does not surface a verification surface at task definition time.

## Current Behavior

- `tasks` table has no verification field. See `agent-runtime/src/db.ts` schema.
- `task_attempts` table (introduced by Proposal 0002) has no verification columns; per-attempt evidence is incomplete without them.
- `runtime.ts` advances task status based solely on adapter exit code and CanonicalOutcome `status` field. See `agent-runtime/src/runtime.ts`.
- Workflows transition on adapter-reported success with no independent check.
- The script adapter has a verification path by construction (it either exits 0 or non-zero) but this property is not generalized to LLM adapters.

## Proposed Change

Add a verification_cmd contract to the task lifecycle. Every task MAY declare a verification command. Every adapter MUST run it before the runtime is allowed to set `status=completed`.

Schema additions to `tasks`:

- `verification_cmd TEXT` — shell command, run from the agent's working directory, exit 0 = verified, non-zero = unverified
- `verification_timeout_ms INTEGER DEFAULT 30000` — timeout for verification
- `verified_at TEXT` — ISO timestamp set when verification passes
- `verification_attempts INTEGER DEFAULT 0` — count of verification runs across attempts

Schema additions to `task_attempts`:

- `verification_exit_status INTEGER` — captured per attempt
- `verification_stdout_path TEXT` — captured per attempt for replay grading

Runtime behavior: after an adapter returns CanonicalOutcome with `status=completed`, the runtime executes `verification_cmd` with the working-directory contract defined in `deploy/ADAPTER_CONTRACTS.md`. If it exits 0, the task transitions to `completed` and `verified_at` is set. If it exits non-zero, the task transitions to `retryable_failure` with retry class `verification_failed`. If `verification_cmd` is null on a task, the task may transition to `completed` only if `task.kind` is in an allowlist (currently: `chore`, `notify`, `observe`) defined in config; all other kinds REQUIRE a verification_cmd.

## What This Removes

- Self-asserted completion as the default trust boundary
- The ambiguity between "adapter said done" and "the work is actually done"
- The need for each workflow to bolt on its own verification logic
- The pattern of failed downstream tasks rediscovering broken upstream completions

## Invariants

1. A task with `task.kind` outside the no-verify allowlist MUST NOT transition to `completed` without a successful `verification_cmd` run.
2. The verification command MUST run after the adapter exits and before the runtime commits the `completed` status.
3. The verification command MUST run with the same working directory contract as the adapter (`deploy/ADAPTER_CONTRACTS.md`).
4. The verification timeout MUST kill the verification process and produce a `verification_failed` retry class.
5. `verification_stdout_path` MUST be captured per attempt for replay grading.
6. The verification command MUST be deterministic — no LLM calls, no network calls that depend on external mutable state. Verification commands that need network MUST hit fixtures or canonical endpoints with stable contracts (e.g., `bun run -e 'console.log("ok")'` is fine; `curl https://random-api.com` is not).
7. The runtime MUST NOT execute a verification command that contains `&&`, `;`, or `|` in its top-level form. If shell composition is needed, the verification logic MUST live in a script file under `scripts/` and the verification_cmd MUST be the path to that script.

## Rollback Anchor

The current trust model is the rollback anchor:

- `tasks` table without verification columns
- `runtime.ts` accepting adapter `status=completed` as terminal
- workflows transitioning on adapter-reported success

To roll back: skip the verification step in `runtime.ts` for one release, then drop the schema columns in a follow-up. The columns are append-only and SQLite tolerates the unused fields.

## Success Criteria For "Observed" -> "Amended Or Retired"

- All adapters route their `completed` outcomes through the verification step
- `task_attempts.verification_exit_status` is populated for every non-allowlist task
- The first observed week shows at least one verification_failed event that would have silently passed under the old contract (this is the evidence the gate works)
- No workflow regression caused by tasks stuck in `retryable_failure` due to malformed verification commands
- The skill contract from Proposal 0008 includes a `verification_cmd` template for each skill

## Task Class

`runtime-execution`

## Variant Strategy

Single. The verification gate is a substrate change; no variants.

## Routing Policy At Launch

- Phase 1: Mutation rollout — all adapters wired, but no_verify allowlist permits any task without verification_cmd to complete (soft launch).
- Phase 2: Constitutional rollout — allowlist clamps to (`chore`, `notify`, `observe`); all other task kinds require verification_cmd. Operator review gate.

## Budget Ceiling

- Verification command timeout: 30s default, configurable per task
- Verification spend: $0 (no LLM calls permitted)
- Implementation tick budget: 3 dispatch cycles to land schema + runtime wiring + adapter contract update

## Target State

Every adapter exit goes through a deterministic verification step before the runtime promotes a task to `completed`. Self-assertion is no longer the default. Replay grading has a verification artifact per attempt. The skill contract (Proposal 0008) ships with verification_cmd templates so skill authors are nudged into the gate by default.

## Schema Changes

```sql
ALTER TABLE tasks ADD COLUMN verification_cmd TEXT;
ALTER TABLE tasks ADD COLUMN verification_timeout_ms INTEGER DEFAULT 30000;
ALTER TABLE tasks ADD COLUMN verified_at TEXT;
ALTER TABLE tasks ADD COLUMN verification_attempts INTEGER DEFAULT 0;

ALTER TABLE task_attempts ADD COLUMN verification_exit_status INTEGER;
ALTER TABLE task_attempts ADD COLUMN verification_stdout_path TEXT;
```

Migration is additive only. Existing rows have `verification_cmd=NULL` and remain valid under Phase 1 routing.

## Runtime Changes

- `src/runtime.ts`: after CanonicalOutcome parse, if `outcome.status === "completed"`, run `runVerification(task, attempt)`; set status based on result.
- New file `src/verification.ts`: subprocess runner with timeout, stdout capture to `state/verifications/<attempt_id>.stdout`, no_verify allowlist enforcement, shell-composition guard.
- `src/db.ts`: schema migration as above.
- Update `deploy/ADAPTER_CONTRACTS.md`: verification step is in the contract; adapters do not skip it; verification stdout/exit are captured per attempt.

## Migration / Backfill

- No backfill of `verification_cmd` on existing tasks
- Phase 1 launch with allowlist permitting null verification_cmd for any task kind
- Phase 2 cutover narrows the allowlist; a one-time sweep flags pending tasks without verification_cmd in non-allowlisted kinds, raises them to operator review

## Tests

Required before Phase 1 merge:

1. Verification command exits 0 → task transitions to `completed`, `verified_at` populated
2. Verification command exits non-zero → task transitions to `retryable_failure` with retry class `verification_failed`
3. Verification command times out → task transitions to `retryable_failure` with retry class `verification_timeout`
4. Task without verification_cmd in allowlisted kind → transitions to `completed` (Phase 1)
5. Task without verification_cmd in non-allowlisted kind under Phase 2 → blocked, operator notified
6. Verification command containing `&&` → rejected at task insert time
7. `task_attempts.verification_stdout_path` captures stdout for replay
8. Verification command runs in working directory matching adapter contract

Fixtures live in `fixtures/verification/`.

## Observability

- `verification_outcome` field in `run_events` for every verification run
- Operator UI shows `verified_at` column and a "self-asserted completed" filter
- Per-attempt verification stdout retrievable via `/api/attempts/:id/verification`
- Weekly evidence report: count of verification_failed events that would have silently passed

## Acceptance Gate

Phase 1 acceptance: schema landed, runtime wired, allowlist permits null verification_cmd. At least one task in a live agent successfully completes through the verification path. Adapter contracts updated.

Phase 2 acceptance: allowlist clamped; no task in production has completed without verification for 7 consecutive days; weekly evidence report shows at least one verification_failed event caught.

## Rollback

Phase 1 rollback: revert runtime.ts to skip verification step. Columns remain (additive only).

Phase 2 rollback: re-widen allowlist to include all task kinds. Operator-reviewed tasks released.

Full rollback: drop verification columns in a follow-up Mutation proposal.

## One-Line Gates

- Delete gate — self-asserted completion as the default trust boundary deleted in favor of verification_cmd enforcement
- Merge gate — schema migration applied, `src/verification.ts` lands, ADAPTER_CONTRACTS.md updated
- Runtime gate — Phase 1 routing live across all council agents; verification stdout captured per attempt
- Observation gate — at least one verification_failed event in 7-day window before Phase 2
- Promotion gate — Phase 2 allowlist clamp applied; non-allowlisted kinds require verification_cmd

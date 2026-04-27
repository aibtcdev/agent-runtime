# Proposal 0002 - Execution Record

State: draft
Class: Standard
Current implementation status: target-only

## Problem Statement

The runtime today treats the `tasks` row as both queue state and execution state, and compiles execution context as an ephemeral prompt string. Neither is sufficient to:

- distinguish one execution attempt from another
- link events and artifacts to the attempt that produced them
- compare variants against stable inputs
- replay judged work

This proposal introduces the two missing runtime spines together, because their schemas and lifecycles are inseparable: a first-class `task_attempts` table that records every adapter launch, and a first-class `bundles` table that persists the compiled per-tick world-model an attempt ran against.

An earlier draft split these into proposals `0002` (bundle artifact) and `0002.5` (execution substrate). Review made clear they are one proposal cut on a false seam — each schema references a column defined in the other, and each invariant depends on both rows existing together. This proposal replaces both drafts.

This proposal deliberately does **not** introduce leases, heartbeats, or mid-flight stale-task reclaim. The runtime is single-runner per VM today and for the foreseeable future. Crash recovery on a single runner is a boot-time sweep, not a heartbeat protocol. See the "Crash Recovery" section below. Lease and fencing-token design is deferred to the concurrent-runner proposal, whenever that becomes warranted.

## Current Behavior

- `openDb()` creates `tasks`, `run_events`, and `workflows`. There is no `task_attempts` table and no `bundles` table. See `agent-runtime/src/db.ts:8-53`.
- `pickNextTask()` and `markRunning()` are two separate statements, not one atomic action. See `agent-runtime/src/db.ts:161-185` and `agent-runtime/src/runtime.ts:40-58`.
- `assembleContext()` synthesizes a prompt string in memory and returns it directly. No bundle file or hash is written. See `agent-runtime/src/context.ts:199-242`.
- `TaskRecord` and `CanonicalOutcome` have no attempt or bundle identifiers. See `agent-runtime/src/types.ts:80-130`.
- `run_events` has no `attempt_id` linkage, so events cannot answer "which attempt produced this artifact or error." See `agent-runtime/src/db.ts:35-41`.
- `finalizeTask()` and `rescheduleTask()` update only the task row. See `agent-runtime/src/db.ts:187-219`.
- `SCHEMA.md` already declares both `TaskAttempt` (§8) and the bundle/constitution requirements (§1b, §9), but local runtime code does not implement them.

## Proposed Change

Add four things together:

1. A first-class `task_attempts` table.
2. A first-class `bundles` table, with `attempt_id NOT NULL`.
3. An atomic `claimNextTask()` transaction that selects a task and creates its `task_attempts` row in one SQL transaction.
4. A boot-time sweep that converts any `running` rows left over from a prior process into `retryable_failure`.

`runner_id` is a process-ownership token generated once at runtime startup and reused for every attempt that process creates. For the first implementation it SHOULD be a stable string derived from host identity, PID, and process start timestamp, for example `<hostname>:<pid>:<started_at>`.

Lifecycle for one tick:

1. **Claim (atomic).** `BEGIN IMMEDIATE; select highest-priority eligible task; update to status=running; insert task_attempts row; insert task_claimed event; COMMIT.` No bundle row yet. No lease fields.
2. **Compile bundle (outside claim).** Read profile, workspace, artifact refs, cached external inputs. Produce canonical JSON. Hash canonical bytes → `bundle_hash`. Write the JSON and the rendered prompt to disk under `state/artifacts/bundles/<yyyy-mm-dd>/<bundle_id>.{json,prompt.txt}`. Insert the `bundles` row pointing at the attempt.
3. **Execute adapter.** Read the persisted bundle's prompt; do not re-assemble context from live state.
4. **Finalize.** In one transaction, close the `task_attempts` row (`status=finished`, `exit_status`, etc.) and update the task row with the outcome.

If bundle compilation fails after the claim, finalize the attempt as failed and block the task before launching the adapter.

### Canonical Bundle JSON

Canonical JSON uses RFC 8785 (JSON Canonicalization Scheme) for byte stability. Do not hand-roll key ordering.

Top-level shape (version 1):

```json
{
  "bundle_version": "1",
  "bundle_id": "...",
  "task": {},
  "workflow": null,
  "agent": {},
  "constitution": {},
  "profile": {},
  "adapter": {},
  "workspace": {},
  "artifacts": [],
  "external_inputs": [],
  "prompt": { "rendered_text": "..." }
}
```

Required fields for every bundle:

- task-row snapshot
- workflow pointer snapshot, if present
- agent identity snapshot (internal name, external name if resolved, on-chain identity ref if resolved)
- constitution hashes (SOUL.md, PURPOSE.md), if available
- profile ID and skill IDs
- adapter kind, adapter ID, model, timeout, autonomy posture, behavior-affecting launch args
- workspace identity: repo root, git SHA, dirty marker, or explicit no-repo marker
- evidence refs and content hashes for every artifact loaded into context
- cached external reads or explicit markers for uncached reads
- rendered prompt text sufficient to reconstruct the adapter input

### Replay Grade — Honest Scope

`replay_grade` has three values, not two:

- `inputs_frozen` — bundle captures every input the runtime can observe; external reads are cached; workspace SHA is clean. Eligible for bundle-hash comparison and judge ranking.
- `best_effort` — at least one required input could not be frozen (dirty workspace, uncached external read, remote-only artifact). Not judge-eligible.
- `non_replayable_model` — adapter targets a remote LLM whose weights are not pinned (hosted Claude, Codex, Hermes via remote provider). The bundle's *inputs* may be frozen, but the model behind the `model` string can change without notice. Judge-eligible only for same-day comparisons; never cross-day.

This replaces the earlier binary `replayable | non_replayable` distinction, which overclaimed determinism for hosted models.

## What This Removes

- The non-atomic gap between `pickNextTask()` and `markRunning()`.
- Prompt-only execution with no durable proof of input context.
- Event streams that cannot answer "which attempt produced this."
- The fiction that `attempt_count` alone is equivalent to a first-class attempt record.
- The two-proposal split (`0002` + `0002.5`) with mutual "nullable for now" references. Both are obsoleted by this file.
- The lease + heartbeat design. Deferred. Do not reintroduce it under the single-runner model.
- The binary `replayable | non_replayable` flag. Replaced with the three-value grade above.

## Invariants

1. Every adapter launch MUST have a `task_attempts` row created before adapter execution starts.
2. Every `task_attempts` row MUST have a `bundles` row before adapter execution starts. Bundle compile failure MUST finalize the attempt as failed without launching the adapter.
3. Claiming a task MUST atomically select the task and insert the `task_attempts` row in one transaction.
4. Every `run_events` row emitted after claim MUST carry `attempt_id`.
5. Finalizing an attempt and updating the task outcome MUST occur in one transaction.
6. `bundle_hash` MUST be derived from RFC 8785 canonical JSON bytes.
7. Any input that can change task behavior MUST either be represented in the bundle or explicitly marked absent.
8. Judge-eligible or tournament-eligible work MUST use `replay_grade = 'inputs_frozen'`.
9. Historical tasks MUST NOT receive fabricated attempt histories or synthetic bundle hashes.
10. After boot, no task MAY remain in `running` status without a live owning process.

## Crash Recovery

Single-runner crash recovery is a boot-time sweep, not a heartbeat protocol.

On startup, before claiming any new work, the runtime runs this SQL in one transaction:

```sql
UPDATE tasks
SET status = 'retryable_failure',
    last_error = 'reclaimed on boot from prior running state',
    updated_at = now
WHERE status = 'running';

UPDATE task_attempts
SET status = 'finished',
    ended_at = now,
    exit_status = 'error',
    retry_class = 'retryable',
    diagnostics_json = json('{"reason":"boot_sweep"}')
WHERE status = 'running';
```

Rationale:

- The runtime is single-runner per VM. There is exactly one process that could own a `running` row at a time.
- If that process is gone (crash, reboot, SIGKILL, OOM), no other process is running the task, and there is nothing to race with.
- A fresh process on boot owns the world. It can safely reclaim everything.
- This is a ~15-line change, not a heartbeat loop, reclaim path, clock-skew model, or fencing-token system.

Stale dispatch-lock files are handled the same way: on startup, if the dispatch lock file exists and its recorded PID is not a live process, clear the lock.

If and when the runtime ever runs concurrent runners, leases and fencing tokens become required. That design is out of scope here and will not be attempted until concurrent runners are a proven need.

## Rollback Anchor

The rollback anchor is the current pre-attempt, pre-bundle flow:

- no `task_attempts` table
- no `bundles` table
- `pickNextTask()` + `markRunning()` as separate statements
- `assembleContext()` returns a prompt string directly

Rollback returns to that model by disabling attempt/bundle writes in `runOnce()` and ignoring the new tables. Rollback is behavioral, not destructive — new tables and rows may remain on disk.

## Success Criteria For "Observed" -> "Amended Or Retired"

- Every new proving-environment tick creates an attempt row and a bundle row before the adapter launches.
- Bundle hashes are stable across repeated runs over the same frozen fixture.
- The boot sweep correctly reclaims simulated crash scenarios without manual DB surgery.
- Events carry `attempt_id` in 100% of cases after migration.
- No judge or tournament code is merged that bypasses the attempt+bundle record.

## Task Class

`runtime-execution-core`

## Variant Strategy

Single

## Routing Policy At Launch

Production

## Budget Ceiling

- Max ticks: unchanged — one active task per runner
- Max variants: 1
- Max spend per tick: one adapter execution plus bundle artifact writes

## Target State

After this proposal lands:

- every tick writes a durable attempt row and bundle artifact before adapter execution
- events and artifacts can be tied to a specific attempt
- bundle hashes are stable, canonicalized, and honestly graded
- boot recovers cleanly from any crash
- no heartbeat, lease, or fencing-token machinery exists or is needed

That substrate is the prerequisite for resilience classification (`0004`), judge ignition (`0005`), and agent-constitution hashing (`0005.5`).

## Schema Changes

Add `task_attempts`:

```sql
CREATE TABLE IF NOT EXISTS task_attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_kind TEXT NOT NULL,
  model TEXT,
  runner_id TEXT NOT NULL,
  bundle_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'finished')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_status TEXT,
  retry_class TEXT,
  prompt_path TEXT,
  stdout_path TEXT,
  stderr_path TEXT,
  result_path TEXT,
  diagnostics_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_attempts_task_id_started_at
  ON task_attempts (task_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_attempts_runner_id_status
  ON task_attempts (runner_id, status);
```

Add `bundles`:

```sql
CREATE TABLE IF NOT EXISTS bundles (
  bundle_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  bundle_hash TEXT NOT NULL UNIQUE,
  agent_id TEXT,
  profile_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  model TEXT,
  variant_id TEXT,
  evaluator_version TEXT,
  replay_grade TEXT NOT NULL CHECK (replay_grade IN ('inputs_frozen', 'best_effort', 'non_replayable_model')),
  relative_path TEXT NOT NULL,
  prompt_relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES task_attempts(attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_bundles_task_id_created_at
  ON bundles (task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bundles_attempt_id
  ON bundles (attempt_id);
```

Extend `run_events`:

```sql
ALTER TABLE run_events ADD COLUMN attempt_id TEXT;

CREATE INDEX IF NOT EXISTS idx_run_events_task_attempt
  ON run_events (task_id, attempt_id, id);
```

Claim queue index on tasks:

```sql
CREATE INDEX IF NOT EXISTS idx_tasks_claim_queue
  ON tasks (status, available_at, priority DESC, created_at ASC);
```

Bundle file contract on disk:

- JSON: `state/artifacts/bundles/<yyyy-mm-dd>/<bundle_id>.json`
- Prompt: `state/artifacts/bundles/<yyyy-mm-dd>/<bundle_id>.prompt.txt`

Dispatch lock file contract on disk:

- Path: `lockPath` from runtime config
- Format: UTF-8 JSON
- Required keys: `pid` (number), `runner_id` (string), `created_at` (ISO8601 string)
- The runtime writes this metadata immediately after acquiring the exclusive file lock.
- Startup stale-lock reclaim reads the JSON and removes the file only when the recorded PID is not live.
- If the file is malformed or empty, startup MAY treat it as stale and replace it before claiming work, but MUST emit `dispatch_lock_stale_cleared` with a reason.

No lease fields are added to `tasks`. No `runner_id`, `heartbeat_at`, or `lease_expires_at` on the task row.

## Runtime Changes

- Replace `pickNextTask()` + `markRunning()` with `claimNextTask()`.
- Split `assembleContext()` into a bundle compiler and a prompt renderer that reads from the persisted bundle.
- Write bundle JSON and prompt artifacts before `executeWithAdapter()`.
- Add DB helpers for attempt lifecycle and bundle insert.
- Thread `attempt_id` through `recordEvent()`.
- Add boot-sweep call at runtime startup, before the first `claimNextTask()`.
- Add stale dispatch-lock check at startup: if PID in lock file is not live, clear it.

Reference boundary for the first implementation PR:

- `claimNextTask()` is required.
- Bundle compilation is required.
- Boot sweep is required.
- No heartbeat loop. No watchdog. No lease expiry scan at claim time.

Out of scope for this proposal:

- judge execution
- tournament scheduling
- bundle-aware routing
- on-chain anchoring
- concurrent-runner support
- fencing tokens
- outbox for external messages

## Migration / Backfill

Migration runs with the runtime stopped.

1. Create `task_attempts`, `bundles`, and the new indexes.
2. Add nullable `attempt_id` to `run_events`.
3. For any legacy `running` tasks: set `status='retryable_failure'`, `available_at=now`, clear any lease-shaped columns that may have been added experimentally, set `last_error='migrated from legacy running state without attempt record'`.
4. Do not fabricate attempt rows for historical work.
5. Do not backfill bundle rows for historical work.
6. Leave historical `run_events.attempt_id` null.

Rationale: synthetic precision is worse than honest gaps.

## Tests

Required cases:

1. Unit: `claimNextTask()` atomically claims the highest-priority eligible task and creates a matching `task_attempts` row.
2. Unit: under simulated concurrent DB access, only one claim succeeds for the same task (proves `BEGIN IMMEDIATE` serialization, documents the single-runner invariant).
3. Unit: canonical bundle hashing is stable for identical logical input (RFC 8785 round-trip).
4. Unit: changing any required input field changes `bundle_hash`.
5. Unit: uncached external input marks `replay_grade='best_effort'`.
6. Unit: remote-model adapter marks `replay_grade='non_replayable_model'` regardless of input freshness.
7. Integration: `runOnce()` creates attempt row, compiles bundle, writes bundle artifacts, runs adapter, finalizes — all in order — and links all events to the attempt.
8. Integration: bundle compile failure after claim finalizes the attempt as failed without launching the adapter.
9. Integration: retryable failure closes attempt row with exit_status/retry_class and reschedules the task.
10. Integration: boot sweep converts pre-existing `running` tasks to `retryable_failure` and finalizes their dangling attempt rows with `diagnostics_json` indicating `boot_sweep`.
11. Integration: startup clears a stale dispatch lock whose PID is no longer live.
12. Replay fixture: repeated runs over the same frozen fixture produce the same `bundle_hash`.

Execution command: `bun test`.

Primary test files:

- `agent-runtime/src/runtime.test.ts`
- fixture data under `agent-runtime/test/fixtures/bundles/`

## Observability

Events added or normalized (all carry `task_id`, `attempt_id`, and `runner_id` where applicable):

- `task_claimed`
- `bundle_compiled` (with `bundle_id`, `bundle_hash`, `replay_grade`)
- `task_attempt_finished`
- `boot_sweep_reclaimed`
- `dispatch_lock_stale_cleared`

Status / snapshot output SHOULD surface most recent bundle hash and attempt ID per task for debugging.

## Acceptance Gate

This proposal is accepted when the proving runtime:

- claims work via `claimNextTask()` with an atomic attempt row
- compiles and persists a bundle artifact before every adapter launch
- emits attempt-linked events in 100% of cases
- passes the boot-sweep and stale-lock tests
- produces stable bundle hashes across fixed fixtures

## Rollback

- Stop calling `claimNextTask()`; revert to `pickNextTask()` + `markRunning()`.
- Stop compiling bundles; revert to in-memory prompt assembly.
- Skip boot sweep; fall back to manual DB cleanup.
- Leave new tables and rows in place; rollback is behavioral, not destructive.

## Known Future Work

Explicitly deferred by this proposal, to be designed when load-bearing:

- **Heartbeats, leases, fencing tokens.** Required the first time concurrent runners are introduced. Will be designed with a monotonic fence token stored by `claimNextTask()` and checked on every finalize/side-effect write; clock-skew assumptions must be stated; see Kleppmann "How to do distributed locking" and the Chubby paper §2.4.
- **Outbox for external effects.** Required the first time a non-idempotent external write (transaction broadcast, Discord post, cross-agent message) is dispatched from a task outcome. `follow_up_tasks` and `external_messages` will be committed to a `*_outbox` table in the same transaction as finalize, and delivered by a separate idempotent reader. `follow_up_tasks` (internal routing) and `external_messages` (foreign endpoint) will be separate tables with separate delivery rules.
- **Formal specification.** A PlusCal / TLA+ module covering claim + finalize + boot-sweep, extended to claim + heartbeat + reclaim + finalize when the concurrent-runner proposal lands.

These are not build items. They are forward-dated commitments so future proposals can reference them instead of rediscovering them.

## One-Line Gates

- Delete gate - prompt-only execution, non-atomic claim, and the two-proposal split (old `0002` + old `0002.5`) are deleted
- Merge gate - attempt schema, bundle schema, claim transaction, boot sweep, and tests reviewed
- Runtime gate - proving runtime creates attempts and bundles for every tick
- Observation gate - bundle hashes stable over fixtures, boot sweep exercises cleanly, no `running` rows survive restarts
- Promotion gate - resilience classification (`0004`), judge ignition (`0005`), and agent-constitution hashing (`0005.5`) may build on top

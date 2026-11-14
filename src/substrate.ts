// ---------------------------------------------------------------------------
// src/substrate.ts — Substrate dispatch intake adapter (Phase 5)
//
// Opt-in: enabled only when config.substrate.enabled === true.
// Zero behavior change on any slot where substrate is not configured.
//
// Contract (stable, parseable log lines):
//   [substrate] claim slot=<id> kinds=<list> result=<jobs.id>     (success — null claim is silent)
//   [substrate] complete jobs.id=<id> epoch=<n>
//   [substrate] fail jobs.id=<id> epoch=<n> reason=<...>
//   [substrate] lease-recovery released=<n>
//   [substrate] skip reason=module-missing error=<...>       (@genesis-works/substrate-db not installed)
//   [substrate] skip reason=credential-fail error=<...>
//   [substrate] skip reason=db-unreachable error=<...>
//   [substrate] skip reason=job-parse-fail error=<...> jobs.id=<id>
//   [substrate] skip reason=local-enqueue-fail error=<...> jobs.id=<id>
//   [substrate] complete-epoch-mismatch jobs.id=<id> expected=<n> actual=<m> — ...
//   [substrate] complete-failed jobs.id=<id> epoch=<n>            (self-contained fallback)
//   [substrate] fail-failed jobs.id=<id> epoch=<n>                (self-contained fallback)
//   [substrate] write-back error=<...> jobs.id=<id>               (transient PG blip; swallowed)
//
// Failure conditions:
//   - Substrate unreachable → tick logs [substrate] skip and continues (NOT crash)
//   - Package missing → tick logs [substrate] skip reason=module-missing; checked before the
//     credential store is touched, so an absent package never decrypts the secret.
//   - Credential resolution fail → tick logs [substrate] skip with distinct line; flag NOT
//     marked initialized so the next tick retries.
//   - claimNextJob returns null → no-op tick (silent — quiet-tick visibility goes through
//     successful-claim and idle-dispatch event lines, not substrate-specific log spam)
//   - jobRowToTaskInput / enqueueTask throw → caught with distinct reason; substrate job
//     stays held under lease and gets returned by releaseExpiredLeases.
//   - completeJob / failJob throw mid-write-back → caught; lease recovery reconciles.
//
// Side-effect duplicate-execution guard:
//   Substrate `jobs.id` + `claim_epoch` are threaded into the local TaskInput as both
//   `payload._substrate_*` fields (for write-back fencing) AND a top-level
//   `payload.idempotency_key = "substrate-<job_id>-e<claim_epoch>"` (for downstream
//   side-effecting handlers to dedup against). Substrate tasks also enqueue with
//   `priority: 1` to maximize same/next-tick execution and minimize the window
//   where a lease can expire on a queued-but-unrun task.
// ---------------------------------------------------------------------------

import type { Database } from "bun:sqlite";
import type { RuntimeConfig, SubstrateConfig, TaskInput, CanonicalOutcome, TaskRecord } from "./types";
import { resolveCredentialRefs } from "./credentials";
import { enqueueTask } from "./db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubstrateTickResult =
  | { claimed: false; reason?: string }
  | { claimed: true; jobId: string; taskId: string; epochUsed: number };

// @genesis-works/substrate-db is an optional dependency (#7): it is loaded on first use, so an
// agent without a substrate config installs and runs without it. The specifier is a variable so
// typecheck doesn't need the package either; the shapes below are the slice of its API used here.
const SUBSTRATE_DB_MODULE = "@genesis-works/substrate-db";

export type JobRow = {
  id: string;
  kind: string;
  payload: unknown;
  /** Typed number, but postgres may hand back a string/bigint; see normalizeEpoch. */
  claim_epoch: number;
};

/**
 * Coerces claim_epoch to a non-negative safe integer, else null. Accepts numbers, decimal
 * digit strings (surrounding whitespace trimmed) and bigints in the safe range; refuses
 * blank, hex, fractional, negative and non-numeric input.
 */
export function normalizeEpoch(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    const t = value.trim();
    if (!/^\d+$/.test(t)) return null;
    n = Number(t);
  } else if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    n = Number(value);
  } else {
    return null;
  }
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Opaque client handle from createSubstrateClient. */
export type SubstrateDb = { readonly __substrateDb?: never } & object;

type WriteResult = { ok: boolean };

type SubstrateDbModule = {
  createSubstrateClient(opts: { host: string; port: number; database: string; user: string; password: string }): SubstrateDb;
  claimNextJob(db: SubstrateDb, slotId: string, kinds: string[], leaseSecs: number): Promise<JobRow | null>;
  completeJob(db: SubstrateDb, jobId: string, result: Record<string, unknown>, extra: undefined, claimEpoch?: number): Promise<WriteResult>;
  failJob(db: SubstrateDb, jobId: string, reason: string, claimEpoch?: number): Promise<WriteResult>;
  releaseExpiredLeases(db: SubstrateDb): Promise<number>;
};

/** Thrown when @genesis-works/substrate-db cannot be loaded (logged as reason=module-missing). */
export class SubstrateModuleMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubstrateModuleMissingError";
  }
}

function isSubstrateModuleNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  const name = SUBSTRATE_DB_MODULE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  // The quoted specifier must be the thing that is missing: a missing transitive dependency
  // of an installed package also reads "Cannot find package 'x' from '.../substrate-db/...'".
  const missing = new RegExp(`Cannot find (package|module) ['"]${name}['"]`).test(err.message);
  return missing && (code === undefined || code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND");
}

let substrateDbModule: Promise<SubstrateDbModule> | null = null;

/** Loads @genesis-works/substrate-db once. A failed load is not cached, so a later tick retries. */
export function loadSubstrateDb(
  importer: () => Promise<unknown> = () => import(SUBSTRATE_DB_MODULE) // injectable for tests
): Promise<SubstrateDbModule> {
  substrateDbModule ??= (importer() as Promise<SubstrateDbModule>).catch((err) => {
    substrateDbModule = null;
    // Only "the package itself is not there" gets the install hint; a package that is
    // installed but throws while loading keeps its real error.
    if (!isSubstrateModuleNotFound(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new SubstrateModuleMissingError(
      `Substrate is enabled but ${SUBSTRATE_DB_MODULE} could not be loaded (${msg}). ` +
        `Install it with \`bun add --no-save ../substrate-db\` (keeps bun.lock clean) or disable config.substrate.`
    );
  });
  return substrateDbModule;
}

/** Test hook: forget the cached module promise. */
export function resetSubstrateDbCache(): void {
  substrateDbModule = null;
}

// ---------------------------------------------------------------------------
// resolveSubstrateConfig
// Returns the validated SubstrateConfig, or null if substrate is disabled.
// ---------------------------------------------------------------------------

export function resolveSubstrateConfig(config: RuntimeConfig): SubstrateConfig | null {
  const sub = config.substrate;
  if (!sub || sub.enabled !== true) {
    return null;
  }
  if (!sub.credential || sub.credential.trim().length === 0) {
    return null;
  }
  if (!sub.kinds || sub.kinds.length === 0) {
    return null;
  }
  if (!sub.slotId || sub.slotId.trim().length === 0) {
    return null;
  }
  return sub;
}

// ---------------------------------------------------------------------------
// createSubstrateConnection
// Loads the substrate package, resolves the substrate DB password from the credential
// store and creates a Drizzle client. Throws SubstrateModuleMissingError if the package
// is absent, and a plain Error on credential resolution failure.
// ---------------------------------------------------------------------------

export async function createSubstrateConnection(
  sub: SubstrateConfig
): Promise<SubstrateDb> {
  // Host is REQUIRED when substrate is enabled — no implicit default to any private IP.
  // A misconfigured slot with substrate.enabled=true but no host would otherwise quietly
  // connect to whatever sits at the prior default; explicit host config is the safer floor.
  if (!sub.host || sub.host.trim().length === 0) {
    throw new Error(
      'Substrate enabled but substrate.host is not set — explicit host required (no implicit default).'
    );
  }

  // Load the package first: if it is absent, fail fast without touching the credential store.
  const { createSubstrateClient } = await loadSubstrateDb();

  // Resolve the credential — the env key SUBSTRATE_DB_CREDENTIAL holds the id.
  // We use resolveCredentialRefs on a fake env object to reuse the existing pattern.
  const fakeEnv: Record<string, string> = {
    SUBSTRATE_DB_CREDENTIAL: sub.credential,
  };
  const resolved = await resolveCredentialRefs(fakeEnv);
  const password = resolved.SUBSTRATE_DB;
  if (!password) {
    throw new Error(`Substrate credential "${sub.credential}" resolved to empty value`);
  }

  return createSubstrateClient({
    host: sub.host,
    port: sub.port ?? 5432,
    database: sub.database ?? "substrate",
    user: sub.user ?? "substrate_app",
    password,
  });
}

// ---------------------------------------------------------------------------
// jobRowToTaskInput
// Convert a claimed JobRow to a TaskInput envelope per the hand-off contract
// documented in docs/shared-substrate/04-access-and-claim.md.
// ---------------------------------------------------------------------------

export function jobRowToTaskInput(job: JobRow): TaskInput {
  const p = (job.payload ?? {}) as Record<string, unknown>;
  // Side-effect duplicate guard: every substrate-sourced task carries a stable
  // idempotency_key derived from (job_id, claim_epoch). Downstream handlers that
  // perform external side-effects (email send, PR open, tx broadcast) check this
  // key in their own dedup store before acting — bounds duplicate execution from
  // lease-expiry-mid-flight scenarios to a no-op on the second handler call.
  // claim_epoch may arrive as string/bigint from postgres; normalise so the fencing in
  // runSubstrateWriteBack (which needs a number) is not silently turned off.
  const claimEpoch = normalizeEpoch(job.claim_epoch);
  if (claimEpoch === null) {
    // Throwing sends the job down the job-parse-fail path (lease recovered), instead of
    // queueing it with a shared "…-enull" idempotency key that would make a re-claim at a
    // real epoch look like a duplicate.
    throw new Error(`invalid claim_epoch ${JSON.stringify(String(job.claim_epoch))} for job ${job.id}`);
  }
  const idempotencyKey = `substrate-${job.id}-e${claimEpoch}`;
  return {
    kind: job.kind,
    source: `substrate:${job.id}`,        // ties runtime task back to the substrate job
    subject: typeof p.subject === "string" ? p.subject : job.kind,
    description: typeof p.description === "string" ? p.description : undefined,
    payload: {
      ...p,
      _substrate_job_id: job.id,           // load-bearing: write-back uses this
      _substrate_claim_epoch: claimEpoch, // load-bearing: epoch fencing
      idempotency_key: idempotencyKey,     // dedup key for side-effecting handlers
    },
    requested_profile: typeof p.requested_profile === "string" ? p.requested_profile : undefined,
    requested_adapter: typeof p.requested_adapter === "string" ? p.requested_adapter : undefined,
    // Priority 1 maximizes same/next-tick execution so the lease window roughly
    // tracks real execution latency instead of waiting behind lower-priority work.
    priority: 1,
    max_attempts: 1, // substrate handles retry via releaseExpiredLeases
  };
}

// ---------------------------------------------------------------------------
// runSubstrateIntakeTick
// Called at the top of runOnce (after pause check, before claimNextTask).
//
// Attempts to claim one substrate job and enqueue it as a local runtime task.
// The local task carries substrate job metadata in its payload so the write-back
// hook (runSubstrateWriteBack) can complete/fail the substrate job on outcome.
//
// Returns { claimed: false } if substrate is disabled, unreachable, or no jobs.
// Returns { claimed: true, jobId, taskId, epochUsed } on successful enqueue.
//
// NEVER throws — every code path inside is wrapped. Distinct skip reasons:
//   db-unreachable      — claimNextJob threw (Postgres connectivity)
//   job-parse-fail      — jobRowToTaskInput threw on a malformed JobRow
//   local-enqueue-fail  — enqueueTask threw (sqlite lock, validator, etc.)
// In the latter two, the substrate `jobs` row stays held under lease and is
// returned by releaseExpiredLeases — another slot (or this slot on a later
// tick) re-claims with a fresh epoch.
// ---------------------------------------------------------------------------

export async function runSubstrateIntakeTick(
  substrateDb: SubstrateDb,
  sub: SubstrateConfig,
  localDb: Database,
  config: RuntimeConfig
): Promise<SubstrateTickResult> {
  const leaseSecs = sub.leaseSecs ?? 300;
  let job: JobRow | null = null;

  try {
    const { claimNextJob } = await loadSubstrateDb();
    job = await claimNextJob(substrateDb, sub.slotId, sub.kinds, leaseSecs);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[substrate] skip reason=db-unreachable error=${msg}`);
    return { claimed: false, reason: "db-unreachable" };
  }

  // Silent no-op on null claim (per contract). Successful claims and idle dispatch
  // are already logged elsewhere; substrate-specific result=none lines would just
  // be tick-rate noise on a queue that's frequently empty.
  if (!job) {
    return { claimed: false };
  }

  const kindList = sub.kinds.join(",");
  console.info(`[substrate] claim slot=${sub.slotId} kinds=${kindList} result=${job.id}`);

  // Convert to TaskInput and enqueue locally — both can throw on malformed payload
  // or local DB pressure. A throw here leaves the substrate job under lease so it
  // gets re-claimed by another slot via releaseExpiredLeases. We DO NOT release the
  // lease eagerly here: doing so would race with the lease-recovery owner.
  let taskInput: TaskInput;
  try {
    taskInput = jobRowToTaskInput(job);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[substrate] skip reason=job-parse-fail error=${msg} jobs.id=${job.id}`);
    return { claimed: false, reason: "job-parse-fail" };
  }

  let task;
  try {
    task = enqueueTask(localDb, config, taskInput);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[substrate] skip reason=local-enqueue-fail error=${msg} jobs.id=${job.id}`);
    return { claimed: false, reason: "local-enqueue-fail" };
  }

  return {
    claimed: true,
    jobId: job.id,
    taskId: task.task_id,
    epochUsed: taskInput.payload._substrate_claim_epoch as number,
  };
}

// ---------------------------------------------------------------------------
// runSubstrateWriteBack
// Called after finalizeTaskAttempt completes for a substrate-sourced task.
//
// Reads the substrate job id and claim_epoch from the task payload, then calls
// completeJob or failJob on the substrate DB with epoch fencing.
//
// If the task source does not start with "substrate:", this is a no-op.
// ---------------------------------------------------------------------------

export async function runSubstrateWriteBack(
  substrateDb: SubstrateDb,
  task: TaskRecord,
  outcome: CanonicalOutcome
): Promise<void> {
  if (!task.source.startsWith("substrate:")) {
    return;
  }

  const payload = task.payload;
  const jobId = typeof payload._substrate_job_id === "string" ? payload._substrate_job_id : null;
  const claimEpoch = normalizeEpoch(payload._substrate_claim_epoch);

  if (!jobId) {
    console.error(`[substrate] write-back skip: missing _substrate_job_id in task ${task.task_id}`);
    return;
  }
  if (claimEpoch === null) {
    // Never write unfenced: a stale executor could overwrite a newer claim's result.
    // The job stays under lease and releaseExpiredLeases reconciles it.
    console.error(`[substrate] write-back skip: missing or malformed _substrate_claim_epoch in task ${task.task_id} jobs.id=${jobId}`);
    return;
  }

  const isSuccess = outcome.status === "completed";

  // The whole substrate write-back is wrapped: a transient PG blip mid-write
  // must NOT propagate out of runOnce and turn a clean local-task completion
  // into an errored tick. The substrate `jobs` row stays held under lease and
  // releaseExpiredLeases reconciles on the next cycle.
  try {
    if (isSuccess) {
      const { completeJob } = await loadSubstrateDb();
      const result = await completeJob(
        substrateDb,
        jobId,
        {
          task_id: task.task_id,
          status: "completed",
          operator_summary: outcome.operator_summary,
          artifact_paths: outcome.artifact_paths ?? [],
          machine_status: outcome.machine_status,
        },
        undefined,
        claimEpoch
      );
      if (result.ok) {
        console.info(`[substrate] complete jobs.id=${jobId} epoch=${claimEpoch}`);
      } else {
        // Self-contained fallback log: don't assume the substrate-db package's
        // log format stays stable across versions. Mismatch / already-done
        // both land here; the package may also log its own line.
        console.warn(`[substrate] complete-failed jobs.id=${jobId} epoch=${claimEpoch}`);
      }
    } else {
      const reason = outcome.operator_summary.slice(0, 500);
      const { failJob } = await loadSubstrateDb();
      const result = await failJob(substrateDb, jobId, reason, claimEpoch);
      if (result.ok) {
        console.info(`[substrate] fail jobs.id=${jobId} epoch=${claimEpoch} reason=${reason.slice(0, 100)}`);
      } else {
        console.warn(`[substrate] fail-failed jobs.id=${jobId} epoch=${claimEpoch}`);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[substrate] write-back error=${msg} jobs.id=${jobId}`);
  }
}

// ---------------------------------------------------------------------------
// runSubstrateLeaseRecovery
// Run releaseExpiredLeases on the substrate DB.
// Only the nominated lease-recovery owner should call this.
// ---------------------------------------------------------------------------

export async function runSubstrateLeaseRecovery(substrateDb: SubstrateDb): Promise<void> {
  try {
    const { releaseExpiredLeases } = await loadSubstrateDb();
    const released = await releaseExpiredLeases(substrateDb);
    if (released > 0) {
      console.info(`[substrate] lease-recovery released=${released}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[substrate] lease-recovery error=${msg}`);
  }
}

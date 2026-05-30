// ---------------------------------------------------------------------------
// src/substrate.ts — Substrate dispatch intake adapter (Phase 5)
//
// Opt-in: enabled only when config.substrate.enabled === true.
// Zero behavior change on any slot where substrate is not configured.
//
// Contract (stable, parseable log lines):
//   [substrate] claim slot=<id> kinds=<list> result=<jobs.id|none>
//   [substrate] complete jobs.id=<id> epoch=<n>
//   [substrate] fail jobs.id=<id> epoch=<n> reason=<...>
//   [substrate] lease-recovery released=<n>
//   [substrate] skip reason=credential-fail error=<...>
//   [substrate] skip reason=db-unreachable error=<...>
//   [substrate] complete-epoch-mismatch jobs.id=<id> expected=<n> actual=<m> — ...
//
// Failure conditions:
//   - Substrate unreachable → tick logs [substrate] skip and continues (NOT crash)
//   - Credential resolution fail → tick logs [substrate] skip with distinct line
//   - claimNextJob returns null → no-op tick (silent)
// ---------------------------------------------------------------------------

import type { Database } from "bun:sqlite";
import {
  createSubstrateClient,
  claimNextJob,
  completeJob,
  failJob,
  releaseExpiredLeases,
  type JobRow,
} from "@genesis-works/substrate-db";
import type { RuntimeConfig, SubstrateConfig, TaskInput, CanonicalOutcome, TaskRecord } from "./types";
import { resolveCredentialRefs } from "./credentials";
import { enqueueTask, getTaskById } from "./db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubstrateTickResult =
  | { claimed: false; reason?: string }
  | { claimed: true; jobId: string; taskId: string; epochUsed: number };

export type SubstrateDb = ReturnType<typeof createSubstrateClient>;

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
// Resolves the substrate DB password from the credential store and creates
// a Drizzle client. Throws on credential resolution failure.
// ---------------------------------------------------------------------------

export async function createSubstrateConnection(
  sub: SubstrateConfig
): Promise<SubstrateDb> {
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
    host: sub.host ?? "192.168.1.31",
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
  return {
    kind: job.kind,
    source: `substrate:${job.id}`,        // ties runtime task back to the substrate job
    subject: typeof p.subject === "string" ? p.subject : job.kind,
    description: typeof p.description === "string" ? p.description : undefined,
    payload: {
      ...p,
      _substrate_job_id: job.id,           // load-bearing: write-back uses this
      _substrate_claim_epoch: job.claim_epoch, // load-bearing: epoch fencing
    },
    requested_profile: typeof p.requested_profile === "string" ? p.requested_profile : undefined,
    requested_adapter: typeof p.requested_adapter === "string" ? p.requested_adapter : undefined,
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
// NEVER throws — all errors are logged and result in { claimed: false }.
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
    job = await claimNextJob(substrateDb, sub.slotId, sub.kinds, leaseSecs);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[substrate] skip reason=db-unreachable error=${msg}`);
    return { claimed: false, reason: "db-unreachable" };
  }

  const kindList = sub.kinds.join(",");
  if (!job) {
    console.info(`[substrate] claim slot=${sub.slotId} kinds=${kindList} result=none`);
    return { claimed: false };
  }

  console.info(`[substrate] claim slot=${sub.slotId} kinds=${kindList} result=${job.id}`);

  // Convert to TaskInput and enqueue locally
  const taskInput = jobRowToTaskInput(job);
  const task = enqueueTask(localDb, config, taskInput);

  return {
    claimed: true,
    jobId: job.id,
    taskId: task.task_id,
    epochUsed: job.claim_epoch,
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
  const claimEpoch = typeof payload._substrate_claim_epoch === "number"
    ? payload._substrate_claim_epoch
    : undefined;

  if (!jobId) {
    console.error(`[substrate] write-back skip: missing _substrate_job_id in task ${task.task_id}`);
    return;
  }

  const isSuccess = outcome.status === "completed";

  if (isSuccess) {
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
      console.info(`[substrate] complete jobs.id=${jobId} epoch=${claimEpoch ?? "none"}`);
    } else {
      // conflict is already logged by completeJob with the [substrate] prefix
    }
  } else {
    const reason = outcome.operator_summary.slice(0, 500);
    const result = await failJob(substrateDb, jobId, reason, claimEpoch);
    if (result.ok) {
      console.info(`[substrate] fail jobs.id=${jobId} epoch=${claimEpoch ?? "none"} reason=${reason.slice(0, 100)}`);
    } else {
      // conflict is already logged by failJob
    }
  }
}

// ---------------------------------------------------------------------------
// runSubstrateLeaseRecovery
// Run releaseExpiredLeases on the substrate DB.
// Only the nominated lease-recovery owner should call this.
// ---------------------------------------------------------------------------

export async function runSubstrateLeaseRecovery(substrateDb: SubstrateDb): Promise<void> {
  try {
    const released = await releaseExpiredLeases(substrateDb);
    if (released > 0) {
      console.info(`[substrate] lease-recovery released=${released}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[substrate] lease-recovery error=${msg}`);
  }
}

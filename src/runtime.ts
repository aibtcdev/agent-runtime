import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { appendLog } from "./logger";
import { compileBundle, renderPromptFromPersistedBundle } from "./context";
import { readDispatchPause } from "./pause";
import { loadProfile } from "./profiles";
import { executeWithAdapter } from "./adapters";
import {
  claimNextTask,
  finalizeTaskAttempt,
  insertBundle,
  recordEvent,
  reclaimRunningWorkOnBoot,
  rescheduleTaskAttempt,
  updateAttemptAdapter
} from "./db";
import { enqueueDueSchedules } from "./schedules";
import type { CanonicalOutcome, TaskAttemptRecord, RuntimeConfig } from "./types";
import { normalizeCanonicalOutcome, verifyCompletedTaskOutcome, verifyTaskInputArtifacts } from "./validation";
import { evaluateActiveWorkflows } from "./workflow-runtime";
import { writeArtifactIfNeeded } from "./artifacts";

type RuntimeSession = {
  runnerId: string;
  startedAt: string;
};

const runtimeSession: RuntimeSession = {
  startedAt: new Date().toISOString(),
  runnerId: `${hostname()}:${process.pid}:${new Date().toISOString()}`
};

let bootPrepared = false;

export function resetRuntimeForTests(): void {
  bootPrepared = false;
}

export function getRunnerId(): string {
  return runtimeSession.runnerId;
}

function isPidLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return code === "EPERM";
  }
}

function clearStartupStaleLockIfNeeded(db: Database, config: RuntimeConfig): { lockedByLivePid: boolean } {
  if (bootPrepared || !existsSync(config.lockPath)) {
    return { lockedByLivePid: false };
  }

  let reason: string | null = null;
  let parsed: Record<string, unknown> | null = null;
  try {
    const content = readFileSync(config.lockPath, "utf8").trim();
    if (!content) {
      reason = "empty_lock_file";
    } else {
      parsed = JSON.parse(content) as Record<string, unknown>;
    }
  } catch {
    reason = "malformed_lock_file";
  }

  const pid = typeof parsed?.pid === "number" ? parsed.pid : NaN;
  if (!reason && Number.isInteger(pid) && isPidLive(pid)) {
    return { lockedByLivePid: true };
  }
  if (!reason) {
    reason = Number.isInteger(pid) ? "pid_not_live" : "missing_or_invalid_pid";
  }

  unlinkSync(config.lockPath);
  recordEvent(db, "dispatch_lock_stale_cleared", null, {
    runner_id: runtimeSession.runnerId,
    reason,
    previous_pid: Number.isInteger(pid) ? pid : null,
    previous_runner_id: typeof parsed?.runner_id === "string" ? parsed.runner_id : null
  });
  return { lockedByLivePid: false };
}

function acquireLock(lockPath: string): number {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  return openSync(lockPath, "wx");
}

function writeLockMetadata(fd: number, runnerId: string): void {
  writeFileSync(fd, JSON.stringify({
    pid: process.pid,
    runner_id: runnerId,
    created_at: new Date().toISOString()
  }), "utf8");
}

function releaseLock(fd: number, lockPath: string): void {
  closeSync(fd);
  unlinkSync(lockPath);
}

function resolveAttemptPaths(
  diagnostics: Record<string, unknown> | undefined,
  fallbackPromptPath: string
): { promptPath: string; stdoutPath: string | null; stderrPath: string | null; resultPath: string | null } {
  return {
    promptPath: typeof diagnostics?.prompt_path === "string" ? diagnostics.prompt_path : fallbackPromptPath,
    stdoutPath: typeof diagnostics?.stdout_path === "string" ? diagnostics.stdout_path : null,
    stderrPath: typeof diagnostics?.stderr_path === "string" ? diagnostics.stderr_path : null,
    resultPath: typeof diagnostics?.result_path === "string" ? diagnostics.result_path : null
  };
}

function withAttemptContext(
  attempt: TaskAttemptRecord,
  bundle: { bundle_id: string; bundle_hash: string }
): Pick<CanonicalOutcome, "attempt_id" | "bundle_id" | "bundle_hash"> {
  return {
    attempt_id: attempt.attempt_id,
    bundle_id: bundle.bundle_id,
    bundle_hash: bundle.bundle_hash
  };
}

export async function runOnce(db: Database, config: RuntimeConfig): Promise<Record<string, unknown>> {
  const staleLock = clearStartupStaleLockIfNeeded(db, config);
  if (staleLock.lockedByLivePid) {
    return { ok: false, reason: "dispatch_locked" };
  }

  let lockFd: number | null = null;
  try {
    lockFd = acquireLock(config.lockPath);
    writeLockMetadata(lockFd, runtimeSession.runnerId);
  } catch {
    return { ok: false, reason: "dispatch_locked" };
  }

  try {
    const pauseState = readDispatchPause(config);
    if (pauseState.paused) {
      recordEvent(db, "dispatch_paused", null, {
        runner_id: runtimeSession.runnerId,
        reason: pauseState.reason
      });
      return { ok: true, status: "paused", paused: true, reason: pauseState.reason };
    }

    if (!bootPrepared) {
      reclaimRunningWorkOnBoot(db, runtimeSession.runnerId);
      bootPrepared = true;
    }

    const scheduleResult = enqueueDueSchedules(db, config);
    if (scheduleResult.schedulesEvaluated > 0) {
      await appendLog(config, {
        event: "schedule_evaluation",
        schedules_evaluated: scheduleResult.schedulesEvaluated,
        tasks_created: scheduleResult.tasksCreated
      });
    }

    const workflowResult = evaluateActiveWorkflows(db, config);
    if (workflowResult.workflowsEvaluated > 0) {
      await appendLog(config, {
        event: "workflow_evaluation",
        workflows_evaluated: workflowResult.workflowsEvaluated,
        tasks_created: workflowResult.tasksCreated
      });
    }

    const claim = claimNextTask(db, runtimeSession.runnerId);
    if (!claim) {
      recordEvent(db, "dispatch_idle", null, { runner_id: runtimeSession.runnerId });
      return { ok: true, status: "idle" };
    }

    const task = claim.task;
    let attempt = claim.attempt;

    const inputIssues = await verifyTaskInputArtifacts(config, task);
    if (inputIssues.length > 0) {
      const blockedOutcome: CanonicalOutcome = {
        status: "blocked",
        operator_summary: `Rejected task before execution: ${inputIssues.join("; ")}`,
        machine_status: "blocked",
        raw_output: inputIssues.join("; "),
        attempt_id: attempt.attempt_id
      };
      finalizeTaskAttempt(db, {
        taskId: task.task_id,
        attemptId: attempt.attempt_id,
        runnerId: runtimeSession.runnerId,
        outcome: blockedOutcome,
        lastError: inputIssues.join("; "),
        exitStatus: "error",
        retryClass: "permanent",
        diagnostics: { reason: "input_verification_failed", input_issues: inputIssues }
      });
      return { ok: false, status: "blocked", task_id: task.task_id, input_issues: inputIssues };
    }

    let profile;
    try {
      profile = await loadProfile(config, task.requested_profile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const blockedOutcome: CanonicalOutcome = {
        status: "blocked",
        operator_summary: `Bundle compilation failed: ${message}`,
        machine_status: "blocked",
        raw_output: message,
        attempt_id: attempt.attempt_id
      };
      finalizeTaskAttempt(db, {
        taskId: task.task_id,
        attemptId: attempt.attempt_id,
        runnerId: runtimeSession.runnerId,
        outcome: blockedOutcome,
        lastError: message,
        exitStatus: "error",
        retryClass: "permanent",
        diagnostics: { reason: "profile_load_failed", error: message }
      });
      return { ok: false, status: "blocked", task_id: task.task_id };
    }

    const adapterId = task.requested_adapter || (
      config.adapters[profile.default_adapter] ? profile.default_adapter : config.defaultAdapter
    );
    const adapterConfig = config.adapters[adapterId];

    if (!adapterConfig) {
      const outcome: CanonicalOutcome = {
        status: "permanent_failure",
        operator_summary: `Unknown adapter: ${adapterId}`,
        machine_status: "failed",
        attempt_id: attempt.attempt_id
      };
      finalizeTaskAttempt(db, {
        taskId: task.task_id,
        attemptId: attempt.attempt_id,
        runnerId: runtimeSession.runnerId,
        outcome,
        lastError: `Unknown adapter: ${adapterId}`,
        exitStatus: "error",
        retryClass: "permanent",
        diagnostics: { reason: "adapter_not_found", adapter_id: adapterId }
      });
      return { ok: false, status: "permanent_failure", task_id: task.task_id };
    }

    updateAttemptAdapter(db, attempt.attempt_id, {
      adapterId,
      adapterKind: adapterConfig.mode,
      model: "model" in adapterConfig ? (adapterConfig.model ?? null) : null
    });
    attempt = {
      ...attempt,
      adapter_id: adapterId,
      adapter_kind: adapterConfig.mode,
      model: "model" in adapterConfig ? (adapterConfig.model ?? null) : null
    };

    let compiledBundle;
    try {
      compiledBundle = await compileBundle({
        db,
        config,
        task,
        attemptId: attempt.attempt_id,
        profile,
        adapterId,
        adapterConfig
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const blockedOutcome: CanonicalOutcome = {
        status: "blocked",
        operator_summary: `Bundle compilation failed: ${message}`,
        machine_status: "blocked",
        raw_output: message,
        attempt_id: attempt.attempt_id
      };
      finalizeTaskAttempt(db, {
        taskId: task.task_id,
        attemptId: attempt.attempt_id,
        runnerId: runtimeSession.runnerId,
        outcome: blockedOutcome,
        lastError: message,
        exitStatus: "error",
        retryClass: "permanent",
        diagnostics: { reason: "bundle_compile_failed", error: message }
      });
      return { ok: false, status: "blocked", task_id: task.task_id };
    }

    insertBundle(db, compiledBundle.bundleRecord, {
      attemptPromptPath: compiledBundle.promptPath,
      runnerId: runtimeSession.runnerId
    });

    await appendLog(config, {
      event: "bundle_compiled",
      task_id: task.task_id,
      attempt_id: attempt.attempt_id,
      bundle_id: compiledBundle.bundleRecord.bundle_id,
      bundle_hash: compiledBundle.bundleRecord.bundle_hash,
      replay_grade: compiledBundle.bundleRecord.replay_grade
    });

    const assembledContext = await renderPromptFromPersistedBundle(config, compiledBundle.bundleRecord);
    const attemptForExecution: TaskAttemptRecord = {
      ...attempt,
      bundle_id: compiledBundle.bundleRecord.bundle_id,
      prompt_path: compiledBundle.promptPath
    };

    const executionResult = await executeWithAdapter({
      task,
      attempt: attemptForExecution,
      bundle: compiledBundle.bundleRecord,
      profile,
      adapterId,
      adapterConfig,
      runtimeConfig: config,
      assembledContext
    });

    await appendLog(config, {
      event: "adapter_result",
      task_id: task.task_id,
      attempt_id: attempt.attempt_id,
      exit_status: executionResult.exitStatus,
      retry_class: executionResult.retryClass,
      diagnostics: executionResult.diagnostics ?? {}
    });

    const attemptPaths = resolveAttemptPaths(executionResult.diagnostics, compiledBundle.promptPath);

    if (executionResult.retryClass === "retryable" && task.attempt_count < task.max_attempts) {
      rescheduleTaskAttempt(db, config, {
        taskId: task.task_id,
        attemptId: attempt.attempt_id,
        runnerId: runtimeSession.runnerId,
        errorMessage: executionResult.rawOutput,
        exitStatus: executionResult.exitStatus,
        retryClass: executionResult.retryClass,
        diagnostics: executionResult.diagnostics,
        ...attemptPaths
      });
      return { ok: false, status: "retryable_failure", task_id: task.task_id, attempt_id: attempt.attempt_id };
    }

    if (executionResult.retryClass === "retryable" && task.attempt_count >= task.max_attempts) {
      const blockedOutcome: CanonicalOutcome = {
        status: "blocked",
        operator_summary: executionResult.rawOutput.slice(0, 4000),
        machine_status: "blocked",
        raw_output: executionResult.rawOutput,
        ...withAttemptContext(attempt, compiledBundle.bundleRecord)
      };
      finalizeTaskAttempt(db, {
        taskId: task.task_id,
        attemptId: attempt.attempt_id,
        runnerId: runtimeSession.runnerId,
        outcome: blockedOutcome,
        lastError: executionResult.rawOutput,
        exitStatus: executionResult.exitStatus,
        retryClass: executionResult.retryClass,
        diagnostics: executionResult.diagnostics,
        ...attemptPaths
      });
      return { ok: false, status: "blocked", task_id: task.task_id, attempt_id: attempt.attempt_id };
    }

    if (executionResult.retryClass === "permanent") {
      const failedOutcome: CanonicalOutcome = {
        status: "permanent_failure",
        operator_summary: executionResult.rawOutput.slice(0, 4000),
        machine_status: "failed",
        raw_output: executionResult.rawOutput,
        ...withAttemptContext(attempt, compiledBundle.bundleRecord)
      };
      finalizeTaskAttempt(db, {
        taskId: task.task_id,
        attemptId: attempt.attempt_id,
        runnerId: runtimeSession.runnerId,
        outcome: failedOutcome,
        lastError: executionResult.rawOutput,
        exitStatus: executionResult.exitStatus,
        retryClass: executionResult.retryClass,
        diagnostics: executionResult.diagnostics,
        ...attemptPaths
      });
      return { ok: false, status: "permanent_failure", task_id: task.task_id, attempt_id: attempt.attempt_id };
    }

    const outcome = {
      ...normalizeCanonicalOutcome(executionResult.rawOutput),
      ...withAttemptContext(attempt, compiledBundle.bundleRecord)
    };
    const writtenArtifactPaths = await writeArtifactIfNeeded(config, task, outcome);
    if (writtenArtifactPaths.length > 0) {
      outcome.artifact_paths = [...new Set([...(outcome.artifact_paths ?? []), ...writtenArtifactPaths])];
    }

    const verificationIssues = await verifyCompletedTaskOutcome(config, task, outcome);
    if (verificationIssues.length > 0) {
      const blockedOutcome: CanonicalOutcome = {
        status: "blocked",
        operator_summary: `Verification failed: ${verificationIssues.join("; ")}`,
        machine_status: "blocked",
        artifact_paths: outcome.artifact_paths,
        raw_output: executionResult.rawOutput,
        ...withAttemptContext(attempt, compiledBundle.bundleRecord)
      };
      finalizeTaskAttempt(db, {
        taskId: task.task_id,
        attemptId: attempt.attempt_id,
        runnerId: runtimeSession.runnerId,
        outcome: blockedOutcome,
        lastError: verificationIssues.join("; "),
        exitStatus: "error",
        retryClass: "permanent",
        diagnostics: {
          ...(executionResult.diagnostics ?? {}),
          reason: "outcome_verification_failed",
          verification_issues: verificationIssues
        },
        ...attemptPaths
      });
      return {
        ok: false,
        status: "blocked",
        task_id: task.task_id,
        attempt_id: attempt.attempt_id,
        verification_issues: verificationIssues
      };
    }

    finalizeTaskAttempt(db, {
      taskId: task.task_id,
      attemptId: attempt.attempt_id,
      runnerId: runtimeSession.runnerId,
      outcome,
      exitStatus: executionResult.exitStatus,
      retryClass: "none",
      diagnostics: executionResult.diagnostics,
      ...attemptPaths
    });
    return { ok: true, status: outcome.status, task_id: task.task_id, attempt_id: attempt.attempt_id };
  } finally {
    if (lockFd !== null) {
      releaseLock(lockFd, config.lockPath);
    }
  }
}

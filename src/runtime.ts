import { closeSync, openSync, unlinkSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { appendLog } from "./logger";
import { assembleContext } from "./context";
import { loadProfile } from "./profiles";
import { executeWithAdapter } from "./adapters";
import { finalizeTask, markRunning, pickNextTask, rescheduleTask, recordEvent } from "./db";
import type { CanonicalOutcome, RuntimeConfig } from "./types";
import { normalizeCanonicalOutcome, verifyCompletedTaskOutcome, verifyTaskInputArtifacts } from "./validation";
import { evaluateActiveWorkflows } from "./workflow-runtime";
import { writeArtifactIfNeeded } from "./artifacts";

function acquireLock(lockPath: string): number {
  return openSync(lockPath, "wx");
}

function releaseLock(fd: number, lockPath: string): void {
  closeSync(fd);
  unlinkSync(lockPath);
}

export async function runOnce(db: Database, config: RuntimeConfig): Promise<Record<string, unknown>> {
  let lockFd: number | null = null;
  try {
    lockFd = acquireLock(config.lockPath);
  } catch {
    return { ok: false, reason: "dispatch_locked" };
  }

  try {
    const workflowResult = evaluateActiveWorkflows(db, config);
    if (workflowResult.workflowsEvaluated > 0) {
      await appendLog(config, {
        event: "workflow_evaluation",
        workflows_evaluated: workflowResult.workflowsEvaluated,
        tasks_created: workflowResult.tasksCreated
      });
    }

    const task = pickNextTask(db);
    if (!task) {
      recordEvent(db, "dispatch_idle", null, {});
      return { ok: true, status: "idle" };
    }

    const inputIssues = await verifyTaskInputArtifacts(config, task);
    if (inputIssues.length > 0) {
      const blockedOutcome: CanonicalOutcome = {
        status: "blocked",
        operator_summary: `Rejected task before execution: ${inputIssues.join("; ")}`,
        machine_status: "blocked",
        raw_output: inputIssues.join("; ")
      };
      finalizeTask(db, task.task_id, blockedOutcome, inputIssues.join("; "));
      return { ok: false, status: "blocked", task_id: task.task_id, input_issues: inputIssues };
    }

    markRunning(db, task.task_id);
    const profile = await loadProfile(config, task.requested_profile);
    const adapterId = task.requested_adapter || profile.default_adapter;
    const adapterConfig = config.adapters[adapterId];

    if (!adapterConfig) {
      const outcome: CanonicalOutcome = {
        status: "permanent_failure",
        operator_summary: `Unknown adapter: ${adapterId}`,
        machine_status: "failed"
      };
      finalizeTask(db, task.task_id, outcome, `Unknown adapter: ${adapterId}`);
      return { ok: false, status: "permanent_failure", task_id: task.task_id };
    }

    const assembledContext = assembleContext(config, profile, task);
    await appendLog(config, {
      event: "assembled_context",
      task_id: task.task_id,
      profile: profile.profile_id,
      adapter: adapterId
    });

    const executionResult = await executeWithAdapter({
      task,
      profile,
      adapterId,
      adapterConfig,
      runtimeConfig: config,
      assembledContext
    });

    await appendLog(config, {
      event: "adapter_result",
      task_id: task.task_id,
      exit_status: executionResult.exitStatus,
      retry_class: executionResult.retryClass,
      diagnostics: executionResult.diagnostics ?? {}
    });

    if (executionResult.retryClass === "retryable" && task.attempt_count + 1 < task.max_attempts) {
      rescheduleTask(db, config, task.task_id, executionResult.rawOutput);
      return { ok: false, status: "retryable_failure", task_id: task.task_id };
    }

    if (executionResult.retryClass === "retryable" && task.attempt_count + 1 >= task.max_attempts) {
      const blockedOutcome: CanonicalOutcome = {
        status: "blocked",
        operator_summary: executionResult.rawOutput.slice(0, 4000),
        machine_status: "blocked",
        raw_output: executionResult.rawOutput
      };
      finalizeTask(db, task.task_id, blockedOutcome, executionResult.rawOutput);
      return { ok: false, status: "blocked", task_id: task.task_id };
    }

    if (executionResult.retryClass === "permanent") {
      const failedOutcome: CanonicalOutcome = {
        status: "permanent_failure",
        operator_summary: executionResult.rawOutput.slice(0, 4000),
        machine_status: "failed",
        raw_output: executionResult.rawOutput
      };
      finalizeTask(db, task.task_id, failedOutcome, executionResult.rawOutput);
      return { ok: false, status: "permanent_failure", task_id: task.task_id };
    }

    const outcome = normalizeCanonicalOutcome(executionResult.rawOutput);
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
        raw_output: executionResult.rawOutput
      };
      finalizeTask(db, task.task_id, blockedOutcome, verificationIssues.join("; "));
      return { ok: false, status: "blocked", task_id: task.task_id, verification_issues: verificationIssues };
    }

    finalizeTask(db, task.task_id, outcome);
    return { ok: true, status: outcome.status, task_id: task.task_id };
  } finally {
    if (lockFd !== null) {
      releaseLock(lockFd, config.lockPath);
    }
  }
}

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { recordVerificationOutcome, recordEvent } from "./db";
import type { TaskRecord, TaskAttemptRecord, RuntimeConfig } from "./types";

// RFC 0007 Phase 1 allowlist: task kinds that may complete without a verification_cmd.
// Phase 2 will clamp this to only chore, notify, observe.
const NO_VERIFY_ALLOWLIST: ReadonlySet<string> = new Set([
  "chore",
  "notify",
  "observe"
]);

export type VerificationResult =
  | { outcome: "passed"; exitStatus: number; stdoutPath: string | null }
  | { outcome: "failed"; exitStatus: number; stdoutPath: string | null; retryClass: "verification_failed" }
  | { outcome: "timed_out"; retryClass: "verification_timeout" }
  | { outcome: "skipped" };

// RFC 0007 §Invariant 7: reject shell composition operators at top level.
export function hasShellComposition(cmd: string): boolean {
  // Only reject &&, ;, | when appearing outside of a quoted string.
  // Simple heuristic: scan unquoted regions for these operators.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) { continue; }
    if (ch === ";") { return true; }
    if (ch === "|") { return true; }
    if (ch === "&" && cmd[i + 1] === "&") { return true; }
  }
  return false;
}

export async function runVerification(
  db: Database,
  config: RuntimeConfig,
  task: TaskRecord,
  attempt: TaskAttemptRecord
): Promise<VerificationResult> {
  if (!task.verification_cmd) {
    // Phase 1: null verification_cmd permitted for any task kind.
    recordEvent(db, "verification_skipped", task.task_id, {
      attempt_id: attempt.attempt_id,
      reason: "no_verification_cmd",
      task_kind: task.kind,
      phase: 1
    }, attempt.attempt_id);
    return { outcome: "skipped" };
  }

  if (hasShellComposition(task.verification_cmd)) {
    // Invariant 7: reject at task insert time, but also guard at run time.
    // Treat as permanent failure so the task author is forced to fix the cmd.
    recordEvent(db, "verification_rejected", task.task_id, {
      attempt_id: attempt.attempt_id,
      reason: "shell_composition_forbidden",
      verification_cmd: task.verification_cmd
    }, attempt.attempt_id);
    return {
      outcome: "failed",
      exitStatus: -1,
      stdoutPath: null,
      retryClass: "verification_failed"
    };
  }

  const verificationDir = path.join(config.stateDir, "verifications");
  mkdirSync(verificationDir, { recursive: true });
  const stdoutPath = path.join(verificationDir, `${attempt.attempt_id}.stdout`);

  const workingDir = "workingDir" in (config.adapters[attempt.adapter_id] ?? {})
    ? (config.adapters[attempt.adapter_id] as { workingDir?: string }).workingDir
    : undefined;

  const timeoutMs = task.verification_timeout_ms;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timedOut = false;

  try {
    proc = Bun.spawn(["sh", "-c", task.verification_cmd], {
      cwd: workingDir,
      stdout: Bun.file(stdoutPath),
      stderr: "pipe",
      env: { ...process.env }
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc?.kill();
    }, timeoutMs);

    const exitCode = await proc.exited;
    clearTimeout(timeoutHandle);

    if (timedOut) {
      recordEvent(db, "verification_outcome", task.task_id, {
        attempt_id: attempt.attempt_id,
        outcome: "timed_out",
        timeout_ms: timeoutMs
      }, attempt.attempt_id);
      return { outcome: "timed_out", retryClass: "verification_timeout" };
    }

    const passed = exitCode === 0;
    recordVerificationOutcome(db, task.task_id, attempt.attempt_id, {
      exitStatus: exitCode,
      stdoutPath,
      passed
    });
    recordEvent(db, "verification_outcome", task.task_id, {
      attempt_id: attempt.attempt_id,
      outcome: passed ? "passed" : "failed",
      exit_status: exitCode,
      stdout_path: stdoutPath
    }, attempt.attempt_id);

    if (passed) {
      return { outcome: "passed", exitStatus: exitCode, stdoutPath };
    }
    return { outcome: "failed", exitStatus: exitCode, stdoutPath, retryClass: "verification_failed" };
  } catch (err) {
    recordEvent(db, "verification_error", task.task_id, {
      attempt_id: attempt.attempt_id,
      error: err instanceof Error ? err.message : String(err)
    }, attempt.attempt_id);
    return { outcome: "failed", exitStatus: -1, stdoutPath: null, retryClass: "verification_failed" };
  }
}

// Validate verification_cmd at task-insert time (RFC 0007 §Invariant 7 + §Tests #6).
export function validateVerificationCmd(cmd: string | null | undefined): string | null {
  if (!cmd) { return null; }
  if (hasShellComposition(cmd)) {
    return `verification_cmd must not contain shell composition operators (&&, ;, |) at the top level; wrap in a script file instead`;
  }
  return null;
}

export { NO_VERIFY_ALLOWLIST };

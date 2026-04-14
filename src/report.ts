import type { RuntimeSnapshot } from "./types";

type WorkflowStateChange =
  | {
      instance_key: string;
      change: "new";
      template: string;
      state: string;
    }
  | {
      instance_key: string;
      change: "advanced" | "completed";
      template: string;
      from_state: string;
      to_state: string;
      completed_at: string | null;
    };

function countByStatus(snapshot: RuntimeSnapshot, status: string): number {
  const match = snapshot.status.counts.find((entry) => entry.status === status);
  return match ? Number(match.count) : 0;
}

function queuedCount(snapshot: RuntimeSnapshot): number {
  return Array.isArray(snapshot.queued_tasks) ? snapshot.queued_tasks.length : 0;
}

function workflowMap(snapshot: RuntimeSnapshot): Map<string, RuntimeSnapshot["workflows"][number]> {
  const workflows = Array.isArray(snapshot.workflows) ? snapshot.workflows : snapshot.active_workflows;
  return new Map(workflows.map((workflow) => [workflow.instance_key, workflow]));
}

function normalizeArtifactFiles(snapshot: RuntimeSnapshot): string[] {
  if (Array.isArray(snapshot.artifact_files) && snapshot.artifact_files.length > 0) {
    return snapshot.artifact_files;
  }

  return (snapshot.recent_completed ?? [])
    .flatMap((task) => task.artifact_paths ?? [])
    .filter((path): path is string => typeof path === "string")
    .sort();
}

function blockedAndRetryableTasks(snapshot: RuntimeSnapshot): Array<Record<string, unknown>> {
  return (snapshot.queued_tasks ?? []).filter((task) =>
    task.status === "blocked" || task.status === "retryable_failure"
  );
}

export function compareSnapshots(before: RuntimeSnapshot, after: RuntimeSnapshot): Record<string, unknown> {
  const beforeArtifacts = new Set(normalizeArtifactFiles(before));
  const newArtifacts = normalizeArtifactFiles(after).filter((path) => !beforeArtifacts.has(path));

  const beforeWorkflows = workflowMap(before);
  const afterWorkflows = workflowMap(after);
  const workflowStateChanges = Array.from(afterWorkflows.entries())
    .map(([instanceKey, workflow]) => {
      const previous = beforeWorkflows.get(instanceKey);
      if (!previous) {
        return {
          instance_key: instanceKey,
          change: "new",
          template: workflow.template,
          state: workflow.current_state
        } satisfies WorkflowStateChange;
      }
      if (previous.current_state !== workflow.current_state || previous.completed_at !== workflow.completed_at) {
        return {
          instance_key: instanceKey,
          change: workflow.completed_at ? "completed" : "advanced",
          template: workflow.template,
          from_state: previous.current_state,
          to_state: workflow.current_state,
          completed_at: workflow.completed_at
        } satisfies WorkflowStateChange;
      }
      return null;
    })
    .filter((item): item is WorkflowStateChange => item !== null);

  const endedIdle = after.status.lastEvent?.["event_type"] === "dispatch_idle";

  return {
    runtime_name: after.runtime_name,
    before_captured_at: before.captured_at,
    after_captured_at: after.captured_at,
    completed_task_delta: {
      before: countByStatus(before, "completed"),
      after: countByStatus(after, "completed"),
      delta: countByStatus(after, "completed") - countByStatus(before, "completed")
    },
    queued_task_delta: {
      before: queuedCount(before),
      after: queuedCount(after),
      delta: queuedCount(after) - queuedCount(before)
    },
    new_artifacts_created: newArtifacts,
    workflow_counts: {
      before: beforeWorkflows.size,
      after: afterWorkflows.size,
      delta: afterWorkflows.size - beforeWorkflows.size
    },
    workflow_state_changes: workflowStateChanges,
    blocked_or_retryable_tasks: blockedAndRetryableTasks(after),
    ended_idle: endedIdle,
    ended_idle_from_event: after.status.lastEvent
  };
}

export async function readSnapshot(path: string): Promise<RuntimeSnapshot> {
  return Bun.file(path).json() as Promise<RuntimeSnapshot>;
}

export async function createSnapshotReport(beforePath: string, afterPath: string): Promise<Record<string, unknown>> {
  const [before, after] = await Promise.all([readSnapshot(beforePath), readSnapshot(afterPath)]);
  return compareSnapshots(before, after);
}

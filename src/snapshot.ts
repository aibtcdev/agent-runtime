import path from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { Database } from "bun:sqlite";
import type { RuntimeConfig, RuntimeSnapshot } from "./types";
import { getAllActiveWorkflows, getAllWorkflows, getStatusSummary } from "./db";

function safeLabel(label?: string): string {
  return (label || "runtime").replace(/[^a-zA-Z0-9-_]/g, "-");
}

export async function writeSnapshot(
  db: Database,
  config: RuntimeConfig,
  label?: string
): Promise<{ snapshotPath: string; snapshot: RuntimeSnapshot }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotsDir = path.join(config.artifactDir, "snapshots");
  await mkdir(snapshotsDir, { recursive: true });

  const queuedTasks = db.query(`
    SELECT task_id, kind, source, subject, status, priority, created_at
    FROM tasks
    WHERE status IN ('pending', 'retryable_failure', 'running', 'blocked')
    ORDER BY priority DESC, datetime(created_at) ASC
  `).all();

  const recentCompleted = db.query(`
    SELECT task_id, kind, source, subject, updated_at, outcome_json
    FROM tasks
    WHERE status = 'completed'
    ORDER BY datetime(updated_at) DESC
    LIMIT 15
  `).all().map((row) => {
    const outcome = JSON.parse(String((row as Record<string, unknown>).outcome_json || "{}"));
    return {
      task_id: String((row as Record<string, unknown>).task_id),
      kind: String((row as Record<string, unknown>).kind),
      source: String((row as Record<string, unknown>).source),
      subject: ((row as Record<string, unknown>).subject ?? null) as string | null,
      updated_at: String((row as Record<string, unknown>).updated_at),
      operator_summary: typeof outcome.operator_summary === "string" ? outcome.operator_summary : "",
      artifact_paths: Array.isArray(outcome.artifact_paths)
        ? outcome.artifact_paths.filter((item: unknown): item is string => typeof item === "string")
        : []
    };
  });

  const allWorkflows = getAllWorkflows(db).map((workflow) => ({
    ...workflow,
    context: workflow.context_json ? JSON.parse(workflow.context_json) as Record<string, unknown> : null
  }));

  const snapshot: RuntimeSnapshot = {
    captured_at: new Date().toISOString(),
    runtime_name: config.runtimeName,
    status: getStatusSummary(db) as RuntimeSnapshot["status"],
    workflows: allWorkflows,
    active_workflows: allWorkflows.filter((workflow) => workflow.completed_at === null),
    queued_tasks: queuedTasks as Array<Record<string, unknown>>,
    recent_completed: recentCompleted,
    artifact_files: await listArtifactFiles(config.artifactDir)
  };

  const snapshotPath = path.join(snapshotsDir, `${timestamp}-${safeLabel(label)}.json`);
  await Bun.write(snapshotPath, JSON.stringify(snapshot, null, 2));
  return { snapshotPath, snapshot };
}

async function listArtifactFiles(rootDir: string, relativeDir = ""): Promise<string[]> {
  const targetDir = path.join(rootDir, relativeDir);
  let entries: Dirent[];
  try {
    entries = await readdir(targetDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (relativePath === "snapshots") {
      continue;
    }
    if (entry.isDirectory()) {
      results.push(...await listArtifactFiles(rootDir, relativePath));
      continue;
    }
    results.push(relativePath);
  }

  return results.sort();
}

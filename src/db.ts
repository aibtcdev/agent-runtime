import { Database } from "bun:sqlite";
import type { CanonicalOutcome, RunEventRecord, RuntimeConfig, TaskInput, TaskRecord, Workflow } from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

export function openDb(config: RuntimeConfig): Database {
  const db = new Database(config.dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      subject TEXT,
      description TEXT,
      priority INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      requested_profile TEXT NOT NULL,
      requested_adapter TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL,
      available_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      outcome_json TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      task_id TEXT,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template TEXT NOT NULL,
      instance_key TEXT NOT NULL UNIQUE,
      current_state TEXT NOT NULL,
      context_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);

  const taskColumns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  const taskColumnNames = new Set(taskColumns.map((column) => column.name));
  if (!taskColumnNames.has("subject")) {
    db.exec("ALTER TABLE tasks ADD COLUMN subject TEXT");
  }
  if (!taskColumnNames.has("description")) {
    db.exec("ALTER TABLE tasks ADD COLUMN description TEXT");
  }

  return db;
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    task_id: String(row.task_id),
    kind: String(row.kind),
    source: String(row.source),
    subject: row.subject ? String(row.subject) : null,
    description: row.description ? String(row.description) : null,
    priority: Number(row.priority),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    requested_profile: String(row.requested_profile),
    requested_adapter: String(row.requested_adapter),
    status: String(row.status) as TaskRecord["status"],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    attempt_count: Number(row.attempt_count),
    max_attempts: Number(row.max_attempts),
    available_at: String(row.available_at),
    started_at: row.started_at ? String(row.started_at) : null,
    finished_at: row.finished_at ? String(row.finished_at) : null,
    outcome: row.outcome_json ? (JSON.parse(String(row.outcome_json)) as CanonicalOutcome) : null,
    last_error: row.last_error ? String(row.last_error) : null
  };
}

export function enqueueTask(db: Database, config: RuntimeConfig, input: TaskInput): TaskRecord {
  const timestamp = nowIso();
  const taskId = crypto.randomUUID();
  const task: TaskRecord = {
    task_id: taskId,
    kind: input.kind,
    source: input.source,
    subject: input.subject ?? null,
    description: input.description ?? null,
    priority: input.priority ?? 5,
    payload: input.payload,
    requested_profile: input.requested_profile ?? config.defaultProfile,
    requested_adapter: input.requested_adapter ?? "",
    status: "pending",
    created_at: timestamp,
    updated_at: timestamp,
    attempt_count: 0,
    max_attempts: input.max_attempts ?? config.maxAttempts,
    available_at: timestamp,
    started_at: null,
    finished_at: null,
    outcome: null,
    last_error: null
  };

  db.query(`
    INSERT INTO tasks (
      task_id, kind, source, subject, description, priority, payload_json, requested_profile, requested_adapter,
      status, created_at, updated_at, attempt_count, max_attempts, available_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.task_id,
    task.kind,
    task.source,
    task.subject,
    task.description,
    task.priority,
    JSON.stringify(task.payload),
    task.requested_profile,
    task.requested_adapter,
    task.status,
    task.created_at,
    task.updated_at,
    task.attempt_count,
    task.max_attempts,
    task.available_at
  );

  recordEvent(db, "task_enqueued", task.task_id, { kind: task.kind, source: task.source });
  return task;
}

export function enqueueTaskIfNew(db: Database, config: RuntimeConfig, input: TaskInput): TaskRecord | null {
  if (taskExistsForSource(db, input.source)) {
    return null;
  }
  return enqueueTask(db, config, input);
}

export function taskExistsForSource(db: Database, source: string): boolean {
  const row = db.query(`
    SELECT task_id
    FROM tasks
    WHERE source = ?
      AND status IN ('pending', 'running', 'retryable_failure')
    LIMIT 1
  `).get(source) as Record<string, unknown> | null;
  return row !== null;
}

export function pickNextTask(db: Database): TaskRecord | null {
  const row = db.query(`
    SELECT * FROM tasks
    WHERE status IN ('pending', 'retryable_failure')
      AND datetime(available_at) <= datetime('now')
      AND attempt_count < max_attempts
    ORDER BY priority DESC, datetime(created_at) ASC
    LIMIT 1
  `).get() as Record<string, unknown> | null;

  return row ? rowToTask(row) : null;
}

export function markRunning(db: Database, taskId: string): void {
  const timestamp = nowIso();
  db.query(`
    UPDATE tasks
    SET status = 'running',
        updated_at = ?,
        started_at = ?,
        attempt_count = attempt_count + 1
    WHERE task_id = ?
  `).run(timestamp, timestamp, taskId);
  recordEvent(db, "task_started", taskId, {});
}

export function finalizeTask(db: Database, taskId: string, outcome: CanonicalOutcome, lastError?: string): void {
  const timestamp = nowIso();
  db.query(`
    UPDATE tasks
    SET status = ?,
        updated_at = ?,
        finished_at = ?,
        outcome_json = ?,
        last_error = ?
    WHERE task_id = ?
  `).run(
    outcome.status,
    timestamp,
    timestamp,
    JSON.stringify(outcome),
    lastError ?? null,
    taskId
  );
  recordEvent(db, "task_finished", taskId, { status: outcome.status, machine_status: outcome.machine_status });
}

export function rescheduleTask(db: Database, config: RuntimeConfig, taskId: string, errorMessage: string): void {
  const availableAt = new Date(Date.now() + config.retryBackoffSeconds * 1000).toISOString();
  db.query(`
    UPDATE tasks
    SET status = 'retryable_failure',
        updated_at = ?,
        available_at = ?,
        last_error = ?
    WHERE task_id = ?
  `).run(nowIso(), availableAt, errorMessage, taskId);
  recordEvent(db, "task_retry_scheduled", taskId, { available_at: availableAt, error: errorMessage });
}

export function recordEvent(db: Database, eventType: string, taskId: string | null, detail: Record<string, unknown>): void {
  db.query(`
    INSERT INTO run_events (event_type, task_id, detail_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(eventType, taskId, JSON.stringify(detail), nowIso());
}

export function getStatusSummary(db: Database): Record<string, unknown> {
  const counts = db.query(`
    SELECT status, COUNT(*) AS count
    FROM tasks
    GROUP BY status
  `).all() as Array<Record<string, unknown>>;

  const recent = db.query(`
    SELECT task_id, kind, status, updated_at
    FROM tasks
    ORDER BY datetime(updated_at) DESC
    LIMIT 5
  `).all() as Array<Record<string, unknown>>;

  const lastEvent = db.query(`
    SELECT event_type, task_id, created_at
    FROM run_events
    ORDER BY id DESC
    LIMIT 1
  `).get() as Record<string, unknown> | null;

  return {
    counts,
    recent,
    lastEvent
  };
}

function rowToRunEvent(row: Record<string, unknown>): RunEventRecord {
  return {
    id: Number(row.id),
    event_type: String(row.event_type),
    task_id: row.task_id ? String(row.task_id) : null,
    detail: JSON.parse(String(row.detail_json)),
    created_at: String(row.created_at)
  };
}

export function getRecentTasks(
  db: Database,
  limit = 20,
  statuses?: TaskRecord["status"][]
): TaskRecord[] {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  if (!statuses || statuses.length === 0) {
    const rows = db.query(`
      SELECT * FROM tasks
      ORDER BY datetime(updated_at) DESC, rowid DESC
      LIMIT ?
    `).all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  }

  const placeholders = statuses.map(() => "?").join(", ");
  const rows = db.query(`
    SELECT * FROM tasks
    WHERE status IN (${placeholders})
    ORDER BY datetime(updated_at) DESC, rowid DESC
    LIMIT ?
  `).all(...statuses, safeLimit) as Array<Record<string, unknown>>;
  return rows.map(rowToTask);
}

export function getTaskCountsByStatus(db: Database): Record<string, number> {
  const rows = db.query(`
    SELECT status, COUNT(*) AS count
    FROM tasks
    GROUP BY status
  `).all() as Array<Record<string, unknown>>;

  const counts = {
    pending: 0,
    running: 0,
    completed: 0,
    blocked: 0,
    retryable_failure: 0,
    permanent_failure: 0
  };

  for (const row of rows) {
    const status = String(row.status);
    if (status in counts) {
      counts[status as keyof typeof counts] = Number(row.count);
    }
  }

  return counts;
}

export function getRecentRunEvents(db: Database, limit = 40): RunEventRecord[] {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const rows = db.query(`
    SELECT *
    FROM run_events
    ORDER BY id DESC
    LIMIT ?
  `).all(safeLimit) as Array<Record<string, unknown>>;
  return rows.map(rowToRunEvent).reverse();
}

export function getRunEventsSince(db: Database, sinceId: number, limit = 50): RunEventRecord[] {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const rows = db.query(`
    SELECT *
    FROM run_events
    WHERE id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(sinceId, safeLimit) as Array<Record<string, unknown>>;
  return rows.map(rowToRunEvent);
}

function rowToWorkflow(row: Record<string, unknown>): Workflow {
  return {
    id: Number(row.id),
    template: String(row.template),
    instance_key: String(row.instance_key),
    current_state: String(row.current_state),
    context_json: row.context_json ? String(row.context_json) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: row.completed_at ? String(row.completed_at) : null
  };
}

export function insertWorkflow(
  db: Database,
  input: { template: string; instance_key: string; current_state: string; context_json?: string | null }
): number {
  const timestamp = nowIso();
  const result = db.query(`
    INSERT INTO workflows (template, instance_key, current_state, context_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.template,
    input.instance_key,
    input.current_state,
    input.context_json ?? null,
    timestamp,
    timestamp
  );
  return Number(result.lastInsertRowid);
}

export function getAllActiveWorkflows(db: Database): Workflow[] {
  const rows = db.query(`
    SELECT *
    FROM workflows
    WHERE completed_at IS NULL
    ORDER BY datetime(updated_at) ASC
  `).all() as Array<Record<string, unknown>>;
  return rows.map(rowToWorkflow);
}

export function getAllWorkflows(db: Database): Workflow[] {
  const rows = db.query(`
    SELECT *
    FROM workflows
    ORDER BY datetime(created_at) ASC, id ASC
  `).all() as Array<Record<string, unknown>>;
  return rows.map(rowToWorkflow);
}

export function getWorkflowById(db: Database, id: number): Workflow | null {
  const row = db.query(`
    SELECT *
    FROM workflows
    WHERE id = ?
    LIMIT 1
  `).get(id) as Record<string, unknown> | null;
  return row ? rowToWorkflow(row) : null;
}

export function getWorkflowByInstanceKey(db: Database, instanceKey: string): Workflow | null {
  const row = db.query(`
    SELECT *
    FROM workflows
    WHERE instance_key = ?
    LIMIT 1
  `).get(instanceKey) as Record<string, unknown> | null;
  return row ? rowToWorkflow(row) : null;
}

export function getLatestCompletedTaskForSource(
  db: Database,
  source: string,
  kinds: string[]
): TaskRecord | null {
  if (kinds.length === 0) {
    return null;
  }
  const placeholders = kinds.map(() => "?").join(", ");
  const row = db.query(`
    SELECT *
    FROM tasks
    WHERE source = ?
      AND status = 'completed'
      AND kind IN (${placeholders})
    ORDER BY datetime(updated_at) DESC
    LIMIT 1
  `).get(source, ...kinds) as Record<string, unknown> | null;
  return row ? rowToTask(row) : null;
}

export function getLatestTaskForSource(db: Database, source: string): TaskRecord | null {
  const row = db.query(`
    SELECT *
    FROM tasks
    WHERE source = ?
    ORDER BY datetime(updated_at) DESC
    LIMIT 1
  `).get(source) as Record<string, unknown> | null;
  return row ? rowToTask(row) : null;
}

export function updateWorkflowState(
  db: Database,
  id: number,
  newState: string,
  contextJson?: string | null
): void {
  db.query(`
    UPDATE workflows
    SET current_state = ?,
        context_json = ?,
        updated_at = ?
    WHERE id = ?
  `).run(newState, contextJson ?? null, nowIso(), id);
  recordEvent(db, "workflow_transitioned", null, { workflow_id: id, new_state: newState });
}

export function completeWorkflow(db: Database, id: number): void {
  db.query(`
    UPDATE workflows
    SET completed_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(nowIso(), nowIso(), id);
  recordEvent(db, "workflow_completed", null, { workflow_id: id });
}

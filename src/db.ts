import { Database } from "bun:sqlite";
import type {
  AttemptExitStatus,
  AttemptRetryClass,
  BundleArtifactRecord,
  CanonicalOutcome,
  ClaimedTaskRecord,
  RunEventRecord,
  RuntimeConfig,
  TaskAttemptRecord,
  TaskInput,
  TaskRecord,
  Workflow
} from "./types";
import { applySchemaMigrations } from "./migrations";

function nowIso(): string {
  return new Date().toISOString();
}

function withImmediateTransaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createDiagnosticsJson(detail: Record<string, unknown> | null | undefined): string | null {
  return detail ? JSON.stringify(detail) : null;
}

function createBundleIndexes(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bundles_task_id_created_at
      ON bundles (task_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_bundles_attempt_id
      ON bundles (attempt_id);

    CREATE INDEX IF NOT EXISTS idx_bundles_bundle_hash
      ON bundles (bundle_hash);
  `);
}

function createRunEventIndexes(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_run_events_task_attempt
      ON run_events (task_id, attempt_id, id);
  `);
}

function resolveAvailableAt(input: TaskInput, timestamp: string): string {
  if (input.available_at) {
    const date = new Date(input.available_at);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`invalid task available_at: ${input.available_at}`);
    }
    return date.toISOString();
  }

  const delayMinutes = input.schedule?.delay_minutes;
  if (delayMinutes == null) {
    return timestamp;
  }
  if (!Number.isFinite(delayMinutes) || delayMinutes < 0) {
    throw new Error("task schedule.delay_minutes must be a non-negative number");
  }
  return new Date(new Date(timestamp).getTime() + delayMinutes * 60_000).toISOString();
}

function indexIncludesColumn(db: Database, indexName: string, columnName: string): boolean {
  const escapedIndexName = indexName.replace(/'/g, "''");
  const rows = db.query(`PRAGMA index_info('${escapedIndexName}')`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function migrateBundlesTableIfNeeded(db: Database): void {
  const indexRows = db.query("PRAGMA index_list(bundles)").all() as Array<{ name: string; unique: number }>;
  const hasUniqueBundleHashIndex = indexRows.some((row) =>
    Number(row.unique) === 1 && indexIncludesColumn(db, String(row.name), "bundle_hash")
  );

  if (!hasUniqueBundleHashIndex) {
    return;
  }

  withImmediateTransaction(db, () => {
    db.exec(`
      CREATE TABLE bundles__migration (
        bundle_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        bundle_hash TEXT NOT NULL,
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

      INSERT INTO bundles__migration (
        bundle_id, task_id, attempt_id, bundle_hash, agent_id, profile_id, adapter_id, model,
        variant_id, evaluator_version, replay_grade, relative_path, prompt_relative_path, created_at
      )
      SELECT
        bundle_id, task_id, attempt_id, bundle_hash, agent_id, profile_id, adapter_id, model,
        variant_id, evaluator_version, replay_grade, relative_path, prompt_relative_path, created_at
      FROM bundles;

      DROP TABLE bundles;
      ALTER TABLE bundles__migration RENAME TO bundles;
    `);
  });
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
      attempt_id TEXT,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS bundles (
      bundle_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      bundle_hash TEXT NOT NULL,
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

    CREATE INDEX IF NOT EXISTS idx_tasks_claim_queue
      ON tasks (status, available_at, priority DESC, created_at ASC);

    CREATE INDEX IF NOT EXISTS idx_task_attempts_task_id_started_at
      ON task_attempts (task_id, started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_task_attempts_runner_id_status
      ON task_attempts (runner_id, status);

  `);

  const taskColumns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  const taskColumnNames = new Set(taskColumns.map((column) => column.name));
  if (!taskColumnNames.has("subject")) {
    db.exec("ALTER TABLE tasks ADD COLUMN subject TEXT");
  }
  if (!taskColumnNames.has("description")) {
    db.exec("ALTER TABLE tasks ADD COLUMN description TEXT");
  }

  const runEventColumns = db.query("PRAGMA table_info(run_events)").all() as Array<{ name: string }>;
  const runEventColumnNames = new Set(runEventColumns.map((column) => column.name));
  if (!runEventColumnNames.has("attempt_id")) {
    db.exec("ALTER TABLE run_events ADD COLUMN attempt_id TEXT");
  }

  migrateBundlesTableIfNeeded(db);
  createBundleIndexes(db);
  createRunEventIndexes(db);
  applySchemaMigrations(db);

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
    last_error: row.last_error ? String(row.last_error) : null,
    verification_cmd: row.verification_cmd ? String(row.verification_cmd) : null,
    verification_timeout_ms: row.verification_timeout_ms != null ? Number(row.verification_timeout_ms) : 30000,
    verified_at: row.verified_at ? String(row.verified_at) : null,
    verification_attempts: row.verification_attempts != null ? Number(row.verification_attempts) : 0
  };
}

function rowToTaskAttempt(row: Record<string, unknown>): TaskAttemptRecord {
  return {
    attempt_id: String(row.attempt_id),
    task_id: String(row.task_id),
    adapter_id: String(row.adapter_id),
    adapter_kind: String(row.adapter_kind),
    model: row.model ? String(row.model) : null,
    runner_id: String(row.runner_id),
    bundle_id: row.bundle_id ? String(row.bundle_id) : null,
    status: String(row.status) as TaskAttemptRecord["status"],
    started_at: String(row.started_at),
    ended_at: row.ended_at ? String(row.ended_at) : null,
    exit_status: row.exit_status ? (String(row.exit_status) as AttemptExitStatus) : null,
    retry_class: row.retry_class ? (String(row.retry_class) as AttemptRetryClass) : null,
    prompt_path: row.prompt_path ? String(row.prompt_path) : null,
    stdout_path: row.stdout_path ? String(row.stdout_path) : null,
    stderr_path: row.stderr_path ? String(row.stderr_path) : null,
    result_path: row.result_path ? String(row.result_path) : null,
    diagnostics: row.diagnostics_json ? (JSON.parse(String(row.diagnostics_json)) as Record<string, unknown>) : null,
    verification_exit_status: row.verification_exit_status != null ? Number(row.verification_exit_status) : null,
    verification_stdout_path: row.verification_stdout_path ? String(row.verification_stdout_path) : null
  };
}

function rowToBundle(row: Record<string, unknown>): BundleArtifactRecord {
  return {
    bundle_id: String(row.bundle_id),
    task_id: String(row.task_id),
    attempt_id: String(row.attempt_id),
    bundle_hash: String(row.bundle_hash),
    agent_id: row.agent_id ? String(row.agent_id) : null,
    profile_id: String(row.profile_id),
    adapter_id: String(row.adapter_id),
    model: row.model ? String(row.model) : null,
    variant_id: row.variant_id ? String(row.variant_id) : null,
    evaluator_version: row.evaluator_version ? String(row.evaluator_version) : null,
    replay_grade: String(row.replay_grade) as BundleArtifactRecord["replay_grade"],
    relative_path: String(row.relative_path),
    prompt_relative_path: String(row.prompt_relative_path),
    created_at: String(row.created_at)
  };
}

// RFC 0007 §Invariant 7: validate verification_cmd inline to avoid circular dependency.
function checkVerificationCmd(cmd: string | null | undefined): void {
  if (!cmd) { return; }
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) { continue; }
    if (ch === ";" || ch === "|" || (ch === "&" && cmd[i + 1] === "&")) {
      throw new Error(
        "verification_cmd must not contain shell composition operators (&&, ;, |) at the top level; wrap in a script file instead"
      );
    }
  }
}

export function enqueueTask(db: Database, config: RuntimeConfig, input: TaskInput): TaskRecord {
  checkVerificationCmd(input.verification_cmd);
  const timestamp = nowIso();
  const availableAt = resolveAvailableAt(input, timestamp);
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
    available_at: availableAt,
    started_at: null,
    finished_at: null,
    outcome: null,
    last_error: null,
    verification_cmd: input.verification_cmd ?? null,
    verification_timeout_ms: input.verification_timeout_ms ?? 30000,
    verified_at: null,
    verification_attempts: 0
  };

  db.query(`
    INSERT INTO tasks (
      task_id, kind, source, subject, description, priority, payload_json, requested_profile, requested_adapter,
      status, created_at, updated_at, attempt_count, max_attempts, available_at,
      verification_cmd, verification_timeout_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    task.available_at,
    task.verification_cmd,
    task.verification_timeout_ms
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

export function cancelTaskByOperator(
  db: Database,
  taskId: string,
  reason?: string | null
): TaskRecord {
  const timestamp = nowIso();
  return withImmediateTransaction(db, () => {
    const task = getTaskById(db, taskId);
    if (!task) {
      throw new Error(`task not found: ${taskId}`);
    }
    if (task.status === "running") {
      throw new Error("running task cancellation is not supported");
    }
    if (["completed", "permanent_failure", "operator_canceled"].includes(task.status)) {
      throw new Error(`task is already terminal: ${task.status}`);
    }

    const outcome: CanonicalOutcome = {
      status: "operator_canceled",
      operator_summary: reason?.trim() ? `Operator canceled: ${reason.trim()}` : "Operator canceled task.",
      machine_status: "canceled"
    };

    db.query(`
      UPDATE tasks
      SET status = 'operator_canceled',
          updated_at = ?,
          finished_at = ?,
          outcome_json = ?,
          last_error = NULL
      WHERE task_id = ?
    `).run(timestamp, timestamp, JSON.stringify(outcome), taskId);

    recordEvent(db, "task_operator_canceled", taskId, {
      reason: reason?.trim() || null,
      previous_status: task.status
    });

    const updated = getTaskById(db, taskId);
    if (!updated) {
      throw new Error(`canceled task disappeared: ${taskId}`);
    }
    return updated;
  });
}

export function getTaskById(db: Database, taskId: string): TaskRecord | null {
  const row = db.query(`
    SELECT *
    FROM tasks
    WHERE task_id = ?
    LIMIT 1
  `).get(taskId) as Record<string, unknown> | null;
  return row ? rowToTask(row) : null;
}

export function getTaskAttemptById(db: Database, attemptId: string): TaskAttemptRecord | null {
  const row = db.query(`
    SELECT *
    FROM task_attempts
    WHERE attempt_id = ?
    LIMIT 1
  `).get(attemptId) as Record<string, unknown> | null;
  return row ? rowToTaskAttempt(row) : null;
}

export function getTaskAttemptsForTask(db: Database, taskId: string): TaskAttemptRecord[] {
  const rows = db.query(`
    SELECT *
    FROM task_attempts
    WHERE task_id = ?
    ORDER BY datetime(started_at) ASC, attempt_id ASC
  `).all(taskId) as Array<Record<string, unknown>>;
  return rows.map(rowToTaskAttempt);
}

export function getBundleByAttemptId(db: Database, attemptId: string): BundleArtifactRecord | null {
  const row = db.query(`
    SELECT *
    FROM bundles
    WHERE attempt_id = ?
    LIMIT 1
  `).get(attemptId) as Record<string, unknown> | null;
  return row ? rowToBundle(row) : null;
}

export function claimNextTask(db: Database, runnerId: string): ClaimedTaskRecord | null {
  const timestamp = nowIso();
  return withImmediateTransaction(db, () => {
    const row = db.query(`
      SELECT *
      FROM tasks
      WHERE status IN ('pending', 'retryable_failure')
        AND datetime(available_at) <= datetime('now')
        AND attempt_count < max_attempts
      ORDER BY priority DESC, datetime(created_at) ASC
      LIMIT 1
    `).get() as Record<string, unknown> | null;

    if (!row) {
      return null;
    }

    const task = rowToTask(row);
    const attemptId = crypto.randomUUID();
    const placeholderAdapterId = task.requested_adapter || "pending-resolution";
    const attempt: TaskAttemptRecord = {
      attempt_id: attemptId,
      task_id: task.task_id,
      adapter_id: placeholderAdapterId,
      adapter_kind: "unresolved",
      model: null,
      runner_id: runnerId,
      bundle_id: null,
      status: "running",
      started_at: timestamp,
      ended_at: null,
      exit_status: null,
      retry_class: null,
      prompt_path: null,
      stdout_path: null,
      stderr_path: null,
      result_path: null,
      diagnostics: null,
      verification_exit_status: null,
      verification_stdout_path: null
    };

    db.query(`
      UPDATE tasks
      SET status = 'running',
          updated_at = ?,
          started_at = ?,
          attempt_count = attempt_count + 1
      WHERE task_id = ?
    `).run(timestamp, timestamp, task.task_id);

    db.query(`
      INSERT INTO task_attempts (
        attempt_id, task_id, adapter_id, adapter_kind, model, runner_id, bundle_id, status,
        started_at, ended_at, exit_status, retry_class, prompt_path, stdout_path, stderr_path, result_path, diagnostics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.attempt_id,
      attempt.task_id,
      attempt.adapter_id,
      attempt.adapter_kind,
      attempt.model,
      attempt.runner_id,
      attempt.bundle_id,
      attempt.status,
      attempt.started_at,
      attempt.ended_at,
      attempt.exit_status,
      attempt.retry_class,
      attempt.prompt_path,
      attempt.stdout_path,
      attempt.stderr_path,
      attempt.result_path,
      createDiagnosticsJson(attempt.diagnostics)
    );

    recordEvent(db, "task_claimed", task.task_id, { runner_id: runnerId }, attemptId);
    const claimedTask = getTaskById(db, task.task_id);
    if (!claimedTask) {
      throw new Error(`Claimed task disappeared: ${task.task_id}`);
    }
    return { task: claimedTask, attempt };
  });
}

export function updateAttemptAdapter(
  db: Database,
  attemptId: string,
  adapter: { adapterId: string; adapterKind: string; model?: string | null }
): void {
  db.query(`
    UPDATE task_attempts
    SET adapter_id = ?,
        adapter_kind = ?,
        model = ?
    WHERE attempt_id = ?
  `).run(adapter.adapterId, adapter.adapterKind, adapter.model ?? null, attemptId);
}

export function insertBundle(
  db: Database,
  bundle: BundleArtifactRecord,
  options: { attemptPromptPath: string; runnerId: string }
): void {
  withImmediateTransaction(db, () => {
    db.query(`
      INSERT INTO bundles (
        bundle_id, task_id, attempt_id, bundle_hash, agent_id, profile_id, adapter_id, model,
        variant_id, evaluator_version, replay_grade, relative_path, prompt_relative_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bundle.bundle_id,
      bundle.task_id,
      bundle.attempt_id,
      bundle.bundle_hash,
      bundle.agent_id,
      bundle.profile_id,
      bundle.adapter_id,
      bundle.model,
      bundle.variant_id,
      bundle.evaluator_version,
      bundle.replay_grade,
      bundle.relative_path,
      bundle.prompt_relative_path,
      bundle.created_at
    );

    db.query(`
      UPDATE task_attempts
      SET bundle_id = ?,
          prompt_path = ?
      WHERE attempt_id = ?
    `).run(bundle.bundle_id, options.attemptPromptPath, bundle.attempt_id);

    recordEvent(
      db,
      "bundle_compiled",
      bundle.task_id,
      {
        runner_id: options.runnerId,
        bundle_id: bundle.bundle_id,
        bundle_hash: bundle.bundle_hash,
        replay_grade: bundle.replay_grade
      },
      bundle.attempt_id
    );
  });
}

type AttemptFinishPaths = {
  promptPath?: string | null;
  stdoutPath?: string | null;
  stderrPath?: string | null;
  resultPath?: string | null;
};

type AttemptFinishInput = {
  taskId: string;
  attemptId: string | null;
  runnerId?: string | null;
  outcome: CanonicalOutcome;
  lastError?: string | null;
  exitStatus: AttemptExitStatus;
  retryClass?: AttemptRetryClass | null;
  diagnostics?: Record<string, unknown> | null;
} & AttemptFinishPaths;

export function finalizeTaskAttempt(db: Database, input: AttemptFinishInput): void {
  const timestamp = nowIso();
  const storedOutcome = input.attemptId
    ? {
        ...input.outcome,
        attempt_id: input.attemptId,
        bundle_id: input.outcome.bundle_id,
        bundle_hash: input.outcome.bundle_hash
      }
    : input.outcome;

  withImmediateTransaction(db, () => {
    if (input.attemptId) {
      db.query(`
        UPDATE task_attempts
        SET status = 'finished',
            ended_at = ?,
            exit_status = ?,
            retry_class = ?,
            prompt_path = COALESCE(?, prompt_path),
            stdout_path = ?,
            stderr_path = ?,
            result_path = ?,
            diagnostics_json = ?
        WHERE attempt_id = ?
      `).run(
        timestamp,
        input.exitStatus,
        input.retryClass ?? "none",
        input.promptPath ?? null,
        input.stdoutPath ?? null,
        input.stderrPath ?? null,
        input.resultPath ?? null,
        createDiagnosticsJson(input.diagnostics),
        input.attemptId
      );

      recordEvent(
        db,
        "task_attempt_finished",
        input.taskId,
        {
          runner_id: input.runnerId ?? null,
          exit_status: input.exitStatus,
          retry_class: input.retryClass ?? "none"
        },
        input.attemptId
      );
    }

    db.query(`
      UPDATE tasks
      SET status = ?,
          updated_at = ?,
          finished_at = ?,
          outcome_json = ?,
          last_error = ?
      WHERE task_id = ?
    `).run(
      storedOutcome.status,
      timestamp,
      timestamp,
      JSON.stringify(storedOutcome),
      input.lastError ?? null,
      input.taskId
    );

    recordEvent(
      db,
      "task_finished",
      input.taskId,
      {
        runner_id: input.runnerId ?? null,
        status: storedOutcome.status,
        machine_status: storedOutcome.machine_status
      },
      input.attemptId
    );
  });
}

type AttemptRetryInput = {
  taskId: string;
  attemptId: string | null;
  runnerId?: string | null;
  errorMessage: string;
  exitStatus: AttemptExitStatus;
  retryClass?: AttemptRetryClass | null;
  diagnostics?: Record<string, unknown> | null;
  availableAtOverride?: string;
  preserveAttemptCount?: boolean;
} & AttemptFinishPaths;

export function rescheduleTaskAttempt(db: Database, config: RuntimeConfig, input: AttemptRetryInput): string {
  const timestamp = nowIso();
  const availableAt = input.availableAtOverride
    ?? new Date(Date.now() + config.retryBackoffSeconds * 1000).toISOString();

  withImmediateTransaction(db, () => {
    if (input.attemptId) {
      db.query(`
        UPDATE task_attempts
        SET status = 'finished',
            ended_at = ?,
            exit_status = ?,
            retry_class = ?,
            prompt_path = COALESCE(?, prompt_path),
            stdout_path = ?,
            stderr_path = ?,
            result_path = ?,
            diagnostics_json = ?
        WHERE attempt_id = ?
      `).run(
        timestamp,
        input.exitStatus,
        input.retryClass ?? "retryable",
        input.promptPath ?? null,
        input.stdoutPath ?? null,
        input.stderrPath ?? null,
        input.resultPath ?? null,
        createDiagnosticsJson(input.diagnostics),
        input.attemptId
      );

      recordEvent(
        db,
        "task_attempt_finished",
        input.taskId,
        {
          runner_id: input.runnerId ?? null,
          exit_status: input.exitStatus,
          retry_class: input.retryClass ?? "retryable"
        },
        input.attemptId
      );
    }

    db.query(`
      UPDATE tasks
      SET status = 'retryable_failure',
          updated_at = ?,
          available_at = ?,
          finished_at = NULL,
          outcome_json = NULL,
          last_error = ?,
          attempt_count = CASE WHEN ? = 1 THEN MAX(0, attempt_count - 1) ELSE attempt_count END
      WHERE task_id = ?
    `).run(timestamp, availableAt, input.errorMessage, input.preserveAttemptCount ? 1 : 0, input.taskId);

    recordEvent(
      db,
      "task_retry_scheduled",
      input.taskId,
      {
        runner_id: input.runnerId ?? null,
        available_at: availableAt,
        error: input.errorMessage
      },
      input.attemptId
    );
  });

  return availableAt;
}

export function reclaimRunningWorkOnBoot(db: Database, runnerId: string): { tasksReclaimed: number; attemptsReclaimed: number } {
  const timestamp = nowIso();
  return withImmediateTransaction(db, () => {
    const reclaimedTasks = db.query(`
      UPDATE tasks
      SET status = 'retryable_failure',
          updated_at = ?,
          available_at = ?,
          finished_at = NULL,
          outcome_json = NULL,
          last_error = 'reclaimed on boot from prior running state'
      WHERE status = 'running'
    `).run(timestamp, timestamp);

    const reclaimedAttempts = db.query(`
      UPDATE task_attempts
      SET status = 'finished',
          ended_at = ?,
          exit_status = 'error',
          retry_class = 'retryable',
          diagnostics_json = ?
      WHERE status = 'running'
    `).run(timestamp, JSON.stringify({ reason: "boot_sweep" }));

    const tasksReclaimed = Number(reclaimedTasks.changes);
    const attemptsReclaimed = Number(reclaimedAttempts.changes);
    if (tasksReclaimed > 0 || attemptsReclaimed > 0) {
      recordEvent(db, "boot_sweep_reclaimed", null, {
        runner_id: runnerId,
        tasks_reclaimed: tasksReclaimed,
        attempts_reclaimed: attemptsReclaimed
      });
    }

    return { tasksReclaimed, attemptsReclaimed };
  });
}

export function finalizeTask(db: Database, taskId: string, outcome: CanonicalOutcome, lastError?: string): void {
  finalizeTaskAttempt(db, {
    taskId,
    attemptId: null,
    outcome,
    lastError: lastError ?? null,
    exitStatus: outcome.machine_status === "ok" ? "ok" : "error",
    retryClass: "none"
  });
}

export function rescheduleTask(db: Database, config: RuntimeConfig, taskId: string, errorMessage: string): void {
  rescheduleTaskAttempt(db, config, {
    taskId,
    attemptId: null,
    errorMessage,
    exitStatus: "error",
    retryClass: "retryable"
  });
}

export function recordVerificationOutcome(
  db: Database,
  taskId: string,
  attemptId: string,
  result: { exitStatus: number; stdoutPath: string | null; passed: boolean }
): void {
  const timestamp = nowIso();
  withImmediateTransaction(db, () => {
    db.query(`
      UPDATE task_attempts
      SET verification_exit_status = ?,
          verification_stdout_path = ?
      WHERE attempt_id = ?
    `).run(result.exitStatus, result.stdoutPath, attemptId);

    db.query(`
      UPDATE tasks
      SET verification_attempts = verification_attempts + 1,
          verified_at = CASE WHEN ? = 1 THEN ? ELSE verified_at END,
          updated_at = ?
      WHERE task_id = ?
    `).run(result.passed ? 1 : 0, timestamp, timestamp, taskId);
  });
}

export function recordEvent(
  db: Database,
  eventType: string,
  taskId: string | null,
  detail: Record<string, unknown>,
  attemptId: string | null = null
): void {
  db.query(`
    INSERT INTO run_events (event_type, task_id, attempt_id, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(eventType, taskId, attemptId, JSON.stringify(detail), nowIso());
}

export function getStatusSummary(db: Database): Record<string, unknown> {
  const counts = db.query(`
    SELECT status, COUNT(*) AS count
    FROM tasks
    GROUP BY status
  `).all() as Array<Record<string, unknown>>;

  const recent = db.query(`
    SELECT
      t.task_id,
      t.kind,
      t.status,
      t.updated_at,
      (
        SELECT ta.attempt_id
        FROM task_attempts ta
        WHERE ta.task_id = t.task_id
        ORDER BY datetime(ta.started_at) DESC, ta.attempt_id DESC
        LIMIT 1
      ) AS attempt_id,
      (
        SELECT b.bundle_hash
        FROM bundles b
        WHERE b.task_id = t.task_id
        ORDER BY datetime(b.created_at) DESC, b.bundle_id DESC
        LIMIT 1
      ) AS bundle_hash
    FROM tasks t
    ORDER BY datetime(t.updated_at) DESC
    LIMIT 5
  `).all() as Array<Record<string, unknown>>;

  const lastEvent = db.query(`
    SELECT event_type, task_id, attempt_id, created_at
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
    attempt_id: row.attempt_id ? String(row.attempt_id) : null,
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
      SELECT *
      FROM tasks
      ORDER BY datetime(updated_at) DESC, rowid DESC
      LIMIT ?
    `).all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  }

  const placeholders = statuses.map(() => "?").join(", ");
  const rows = db.query(`
    SELECT *
    FROM tasks
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
    permanent_failure: 0,
    operator_canceled: 0
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

import type { Database } from "bun:sqlite";
import { enqueueTaskIfNew, recordEvent } from "./db";
import type { RecurringScheduleInput, RecurringScheduleRecord, RuntimeConfig, TaskInput } from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

function nextIntervalTime(fromIso: string, intervalSeconds: number): string {
  return new Date(new Date(fromIso).getTime() + intervalSeconds * 1000).toISOString();
}

function rowToSchedule(row: Record<string, unknown>): RecurringScheduleRecord {
  return {
    schedule_id: String(row.schedule_id),
    name: String(row.name),
    enabled: Number(row.enabled) === 1,
    interval_seconds: Number(row.interval_seconds),
    next_run_at: String(row.next_run_at),
    last_run_at: row.last_run_at ? String(row.last_run_at) : null,
    task: JSON.parse(String(row.task_json)) as TaskInput,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

export function upsertRecurringSchedule(db: Database, input: RecurringScheduleInput): RecurringScheduleRecord {
  if (!input.name.trim()) {
    throw new Error("schedule name is required");
  }
  if (!Number.isInteger(input.interval_seconds) || input.interval_seconds <= 0) {
    throw new Error("schedule interval_seconds must be a positive integer");
  }
  const timestamp = nowIso();
  const scheduleId = input.schedule_id ?? crypto.randomUUID();
  const nextRunAt = input.next_run_at ? new Date(input.next_run_at).toISOString() : timestamp;

  db.query(`
    INSERT INTO schedules (
      schedule_id, name, enabled, interval_seconds, next_run_at, last_run_at, task_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      enabled = excluded.enabled,
      interval_seconds = excluded.interval_seconds,
      next_run_at = excluded.next_run_at,
      task_json = excluded.task_json,
      updated_at = excluded.updated_at
  `).run(
    scheduleId,
    input.name,
    input.enabled === false ? 0 : 1,
    input.interval_seconds,
    nextRunAt,
    JSON.stringify(input.task),
    timestamp,
    timestamp
  );

  const schedule = getScheduleByName(db, input.name);
  if (!schedule) {
    throw new Error(`schedule disappeared after upsert: ${input.name}`);
  }
  recordEvent(db, "schedule_upserted", null, { name: input.name, schedule_id: schedule.schedule_id });
  return schedule;
}

export function getScheduleByName(db: Database, name: string): RecurringScheduleRecord | null {
  const row = db.query(`
    SELECT *
    FROM schedules
    WHERE name = ?
    LIMIT 1
  `).get(name) as Record<string, unknown> | null;
  return row ? rowToSchedule(row) : null;
}

export function getAllSchedules(db: Database): RecurringScheduleRecord[] {
  const rows = db.query(`
    SELECT *
    FROM schedules
    ORDER BY enabled DESC, datetime(next_run_at) ASC, name ASC
  `).all() as Array<Record<string, unknown>>;
  return rows.map(rowToSchedule);
}

export function getDueSchedules(db: Database, atIso = nowIso()): RecurringScheduleRecord[] {
  const rows = db.query(`
    SELECT *
    FROM schedules
    WHERE enabled = 1
      AND datetime(next_run_at) <= datetime(?)
    ORDER BY datetime(next_run_at) ASC, name ASC
  `).all(atIso) as Array<Record<string, unknown>>;
  return rows.map(rowToSchedule);
}

export function markScheduleRan(db: Database, scheduleId: string, ranAt: string, nextRunAt: string): void {
  db.query(`
    UPDATE schedules
    SET last_run_at = ?,
        next_run_at = ?,
        updated_at = ?
    WHERE schedule_id = ?
  `).run(ranAt, nextRunAt, nowIso(), scheduleId);
}

export function enqueueDueSchedules(
  db: Database,
  config: RuntimeConfig,
  atIso = nowIso()
): { schedulesEvaluated: number; tasksCreated: number; taskIds: string[] } {
  const due = getDueSchedules(db, atIso);
  let tasksCreated = 0;
  const taskIds: string[] = [];

  for (const schedule of due) {
    const dueAt = schedule.next_run_at;
    const taskInput: TaskInput = {
      ...schedule.task,
      source: `${schedule.task.source || `schedule:${schedule.name}`}:${dueAt}`
    };
    const task = enqueueTaskIfNew(db, config, taskInput);
    if (task) {
      tasksCreated += 1;
      taskIds.push(task.task_id);
      recordEvent(db, "schedule_task_created", task.task_id, {
        schedule_id: schedule.schedule_id,
        schedule_name: schedule.name,
        due_at: dueAt
      });
    }
    markScheduleRan(db, schedule.schedule_id, atIso, nextIntervalTime(dueAt, schedule.interval_seconds));
  }

  return { schedulesEvaluated: due.length, tasksCreated, taskIds };
}

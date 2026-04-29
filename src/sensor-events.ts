import type { Database } from "bun:sqlite";
import { recordEvent } from "./db";
import type { SensorEventInput, SensorEventRecord } from "./types";

function rowToSensorEvent(row: Record<string, unknown>): SensorEventRecord {
  return {
    sensor_event_id: String(row.sensor_event_id),
    sensor_id: String(row.sensor_id),
    event_id: String(row.event_id),
    observed_at: String(row.observed_at),
    source_ref: String(row.source_ref),
    dedupe_key: String(row.dedupe_key),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    task_id: row.task_id ? String(row.task_id) : null,
    workflow_id: row.workflow_id == null ? null : Number(row.workflow_id),
    created_at: String(row.created_at)
  };
}

export function recordSensorEvent(
  db: Database,
  input: SensorEventInput
): SensorEventRecord | null {
  const timestamp = new Date().toISOString();
  const observedAt = input.observed_at ? new Date(input.observed_at).toISOString() : timestamp;
  const sensorEventId = crypto.randomUUID();
  const insert = db.query(`
    INSERT OR IGNORE INTO sensor_events (
      sensor_event_id, sensor_id, event_id, observed_at, source_ref, dedupe_key, payload_json, task_id, workflow_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sensorEventId,
    input.sensor_id,
    input.event_id,
    observedAt,
    input.source_ref,
    input.dedupe_key,
    JSON.stringify(input.payload),
    null,
    null,
    timestamp
  );

  if (Number(insert.changes) === 0) {
    recordEvent(db, "sensor_event_deduped", null, {
      sensor_id: input.sensor_id,
      event_id: input.event_id,
      dedupe_key: input.dedupe_key
    });
    return null;
  }

  recordEvent(db, "sensor_event_recorded", null, {
    sensor_id: input.sensor_id,
    event_id: input.event_id,
    dedupe_key: input.dedupe_key
  });
  const row = db.query(`
    SELECT *
    FROM sensor_events
    WHERE sensor_event_id = ?
    LIMIT 1
  `).get(sensorEventId) as Record<string, unknown> | null;
  return row ? rowToSensorEvent(row) : null;
}

export function updateSensorEventResult(
  db: Database,
  sensorEventId: string,
  result: { taskId?: string | null; workflowId?: number | null }
): SensorEventRecord {
  db.query(`
    UPDATE sensor_events
    SET task_id = ?,
        workflow_id = ?
    WHERE sensor_event_id = ?
  `).run(result.taskId ?? null, result.workflowId ?? null, sensorEventId);

  const row = db.query(`
    SELECT *
    FROM sensor_events
    WHERE sensor_event_id = ?
    LIMIT 1
  `).get(sensorEventId) as Record<string, unknown> | null;
  if (!row) {
    throw new Error(`sensor event not found: ${sensorEventId}`);
  }
  return rowToSensorEvent(row);
}

export function getRecentSensorEvents(db: Database, limit = 50): SensorEventRecord[] {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const rows = db.query(`
    SELECT *
    FROM sensor_events
    ORDER BY datetime(created_at) DESC
    LIMIT ?
  `).all(safeLimit) as Array<Record<string, unknown>>;
  return rows.map(rowToSensorEvent);
}

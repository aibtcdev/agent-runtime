import type { Database } from "bun:sqlite";

type Migration = {
  id: string;
  description: string;
  apply: (db: Database) => void;
};

const migrations: Migration[] = [
  {
    id: "0001_runtime_core",
    description: "record baseline runtime schema",
    apply: () => {
      // Core tables are created by openDb for compatibility with pre-migration DBs.
    }
  },
  {
    id: "0002_schedules_and_sensor_events",
    description: "add recurring schedules and sensor event intake",
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schedules (
          schedule_id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          enabled INTEGER NOT NULL,
          interval_seconds INTEGER NOT NULL,
          next_run_at TEXT NOT NULL,
          last_run_at TEXT,
          task_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sensor_events (
          sensor_event_id TEXT PRIMARY KEY,
          sensor_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          source_ref TEXT NOT NULL,
          dedupe_key TEXT NOT NULL UNIQUE,
          payload_json TEXT NOT NULL,
          task_id TEXT,
          workflow_id INTEGER,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_schedules_due
          ON schedules (enabled, next_run_at);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_sensor_events_sensor_event
          ON sensor_events (sensor_id, event_id);
      `);
    }
  },
  {
    id: "0003_verification_gate",
    description: "RFC 0007 Phase 1: verification_cmd contract on tasks and task_attempts",
    apply: (db) => {
      const taskColumns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      const taskColumnNames = new Set(taskColumns.map((c) => c.name));
      if (!taskColumnNames.has("verification_cmd")) {
        db.exec("ALTER TABLE tasks ADD COLUMN verification_cmd TEXT");
      }
      if (!taskColumnNames.has("verification_timeout_ms")) {
        db.exec("ALTER TABLE tasks ADD COLUMN verification_timeout_ms INTEGER DEFAULT 30000");
      }
      if (!taskColumnNames.has("verified_at")) {
        db.exec("ALTER TABLE tasks ADD COLUMN verified_at TEXT");
      }
      if (!taskColumnNames.has("verification_attempts")) {
        db.exec("ALTER TABLE tasks ADD COLUMN verification_attempts INTEGER DEFAULT 0");
      }

      const attemptColumns = db.query("PRAGMA table_info(task_attempts)").all() as Array<{ name: string }>;
      const attemptColumnNames = new Set(attemptColumns.map((c) => c.name));
      if (!attemptColumnNames.has("verification_exit_status")) {
        db.exec("ALTER TABLE task_attempts ADD COLUMN verification_exit_status INTEGER");
      }
      if (!attemptColumnNames.has("verification_stdout_path")) {
        db.exec("ALTER TABLE task_attempts ADD COLUMN verification_stdout_path TEXT");
      }
    }
  },
  {
    id: "0004_lessons_layer",
    description: "RFC 0009 Phase 1: lesson_topic column on tasks",
    apply: (db) => {
      const taskColumns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      const taskColumnNames = new Set(taskColumns.map((c) => c.name));
      if (!taskColumnNames.has("lesson_topic")) {
        db.exec("ALTER TABLE tasks ADD COLUMN lesson_topic TEXT");
      }
    }
  }
];

export function applySchemaMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.query("SELECT id FROM schema_migrations").all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((row) => row.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.apply(db);
      db.query(`
        INSERT INTO schema_migrations (id, description, applied_at)
        VALUES (?, ?, ?)
      `).run(migration.id, migration.description, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function getAppliedSchemaMigrations(db: Database): Array<{ id: string; description: string; applied_at: string }> {
  return db.query(`
    SELECT id, description, applied_at
    FROM schema_migrations
    ORDER BY id ASC
  `).all() as Array<{ id: string; description: string; applied_at: string }>;
}

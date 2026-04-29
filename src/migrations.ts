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

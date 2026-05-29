import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { openDb, enqueueTask } from "./db";
import { runVerification, hasShellComposition, validateVerificationCmd } from "./verification";
import type { RuntimeConfig, TaskRecord, TaskAttemptRecord } from "./types";

const FIXTURES = path.resolve(import.meta.dir, "../fixtures/verification");

function makeConfig(stateDir: string): RuntimeConfig {
  return {
    runtimeName: "test",
    runtimePolicy: "test",
    stateDir,
    logDir: stateDir,
    artifactDir: stateDir,
    dbPath: path.join(stateDir, "test.db"),
    lockPath: path.join(stateDir, "dispatch-lock.json"),
    defaultProfile: "default",
    defaultAdapter: "script",
    maxAttempts: 3,
    retryBackoffSeconds: 1,
    profiles: {},
    adapters: {}
  };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: "task-1",
    kind: "impl",
    source: "test",
    subject: null,
    description: null,
    priority: 5,
    payload: {},
    requested_profile: "default",
    requested_adapter: "script",
    status: "running",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    attempt_count: 1,
    max_attempts: 3,
    available_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    outcome: null,
    last_error: null,
    verification_cmd: null,
    verification_timeout_ms: 30000,
    verified_at: null,
    verification_attempts: 0,
    ...overrides
  };
}

function makeAttempt(overrides: Partial<TaskAttemptRecord> = {}): TaskAttemptRecord {
  return {
    attempt_id: "attempt-1",
    task_id: "task-1",
    adapter_id: "script",
    adapter_kind: "script",
    model: null,
    runner_id: "runner-1",
    bundle_id: null,
    status: "running",
    started_at: new Date().toISOString(),
    ended_at: null,
    exit_status: null,
    retry_class: null,
    prompt_path: null,
    stdout_path: null,
    stderr_path: null,
    result_path: null,
    diagnostics: null,
    verification_exit_status: null,
    verification_stdout_path: null,
    ...overrides
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = path.join("/tmp", `verification-test-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// §Tests #1: verification command exits 0 → task transitions to completed, verified_at populated
test("verification passes: exit 0 sets verified_at on task", async () => {
  await withTempDir(async (dir) => {
    const config = makeConfig(dir);
    const db = openDb(config);
    const task = makeTask({ verification_cmd: path.join(FIXTURES, "pass.sh") });
    const attempt = makeAttempt();

    // Insert a minimal task row so recordVerificationOutcome has something to update
    db.exec(`INSERT INTO tasks (task_id, kind, source, priority, payload_json, requested_profile, requested_adapter, status, created_at, updated_at, attempt_count, max_attempts, available_at)
      VALUES ('task-1','impl','test',5,'{}','default','script','running','2026-01-01','2026-01-01',1,3,'2026-01-01')`);
    db.exec(`INSERT INTO task_attempts (attempt_id, task_id, adapter_id, adapter_kind, runner_id, status, started_at)
      VALUES ('attempt-1','task-1','script','script','runner-1','running','2026-01-01')`);

    const result = await runVerification(db, config, task, attempt);
    expect(result.outcome).toBe("passed");
    if (result.outcome === "passed") {
      expect(result.exitStatus).toBe(0);
      expect(result.stdoutPath).toBeTruthy();
    }

    const row = db.query("SELECT verified_at, verification_attempts FROM tasks WHERE task_id = 'task-1'").get() as Record<string, unknown>;
    expect(row.verified_at).toBeTruthy();
    expect(Number(row.verification_attempts)).toBe(1);
  });
});

// §Tests #2: verification command exits non-zero → retryable_failure with verification_failed
test("verification fails: exit 1 returns verification_failed retry class", async () => {
  await withTempDir(async (dir) => {
    const config = makeConfig(dir);
    const db = openDb(config);
    const task = makeTask({ verification_cmd: path.join(FIXTURES, "fail.sh") });
    const attempt = makeAttempt();

    db.exec(`INSERT INTO tasks (task_id, kind, source, priority, payload_json, requested_profile, requested_adapter, status, created_at, updated_at, attempt_count, max_attempts, available_at)
      VALUES ('task-1','impl','test',5,'{}','default','script','running','2026-01-01','2026-01-01',1,3,'2026-01-01')`);
    db.exec(`INSERT INTO task_attempts (attempt_id, task_id, adapter_id, adapter_kind, runner_id, status, started_at)
      VALUES ('attempt-1','task-1','script','script','runner-1','running','2026-01-01')`);

    const result = await runVerification(db, config, task, attempt);
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.exitStatus).toBe(1);
      expect(result.retryClass).toBe("verification_failed");
    }

    const row = db.query("SELECT verified_at, verification_attempts FROM tasks WHERE task_id = 'task-1'").get() as Record<string, unknown>;
    expect(row.verified_at).toBeNull();
    expect(Number(row.verification_attempts)).toBe(1);
  });
});

// §Tests #3: verification command times out → verification_timeout retry class
test("verification timeout: slow command returns verification_timeout", async () => {
  await withTempDir(async (dir) => {
    const config = makeConfig(dir);
    const db = openDb(config);
    const task = makeTask({
      verification_cmd: path.join(FIXTURES, "timeout.sh"),
      verification_timeout_ms: 200
    });
    const attempt = makeAttempt();

    db.exec(`INSERT INTO tasks (task_id, kind, source, priority, payload_json, requested_profile, requested_adapter, status, created_at, updated_at, attempt_count, max_attempts, available_at)
      VALUES ('task-1','impl','test',5,'{}','default','script','running','2026-01-01','2026-01-01',1,3,'2026-01-01')`);
    db.exec(`INSERT INTO task_attempts (attempt_id, task_id, adapter_id, adapter_kind, runner_id, status, started_at)
      VALUES ('attempt-1','task-1','script','script','runner-1','running','2026-01-01')`);

    const result = await runVerification(db, config, task, attempt);
    expect(result.outcome).toBe("timed_out");
    if (result.outcome === "timed_out") {
      expect(result.retryClass).toBe("verification_timeout");
    }
  });
}, 5000);

// §Tests #4: task without verification_cmd in Phase 1 → skipped (completes)
test("Phase 1: null verification_cmd is skipped for any task kind", async () => {
  await withTempDir(async (dir) => {
    const config = makeConfig(dir);
    const db = openDb(config);
    const task = makeTask({ kind: "impl", verification_cmd: null });
    const attempt = makeAttempt();

    db.exec(`INSERT INTO tasks (task_id, kind, source, priority, payload_json, requested_profile, requested_adapter, status, created_at, updated_at, attempt_count, max_attempts, available_at)
      VALUES ('task-1','impl','test',5,'{}','default','script','running','2026-01-01','2026-01-01',1,3,'2026-01-01')`);
    db.exec(`INSERT INTO task_attempts (attempt_id, task_id, adapter_id, adapter_kind, runner_id, status, started_at)
      VALUES ('attempt-1','task-1','script','script','runner-1','running','2026-01-01')`);

    const result = await runVerification(db, config, task, attempt);
    expect(result.outcome).toBe("skipped");
  });
});

// §Tests #6: verification_cmd containing && → rejected at task insert time
test("shell composition guard: && in verification_cmd throws at enqueue", () => {
  expect(() => {
    const db = new Database(":memory:");
    const config = makeConfig("/tmp/not-used");
    openDb({ ...config, dbPath: ":memory:" } as RuntimeConfig);
    enqueueTask(db, config, {
      kind: "impl",
      source: "test",
      payload: {},
      verification_cmd: "echo a && echo b"
    });
  }).toThrow(/shell composition/);
});

test("shell composition guard: ; in verification_cmd throws at enqueue", () => {
  expect(() => {
    enqueueTask(new Database(":memory:"), makeConfig("/tmp/not-used"), {
      kind: "impl",
      source: "test",
      payload: {},
      verification_cmd: "echo a; echo b"
    });
  }).toThrow(/shell composition/);
});

test("shell composition guard: pipe in verification_cmd throws at enqueue", () => {
  expect(() => {
    enqueueTask(new Database(":memory:"), makeConfig("/tmp/not-used"), {
      kind: "impl",
      source: "test",
      payload: {},
      verification_cmd: "cat file | grep ok"
    });
  }).toThrow(/shell composition/);
});

// §Tests #7: verification_stdout_path captured per attempt
test("verification stdout is captured to file", async () => {
  await withTempDir(async (dir) => {
    const config = makeConfig(dir);
    const db = openDb(config);
    const task = makeTask({ verification_cmd: path.join(FIXTURES, "pass-with-stdout.sh") });
    const attempt = makeAttempt();

    db.exec(`INSERT INTO tasks (task_id, kind, source, priority, payload_json, requested_profile, requested_adapter, status, created_at, updated_at, attempt_count, max_attempts, available_at)
      VALUES ('task-1','impl','test',5,'{}','default','script','running','2026-01-01','2026-01-01',1,3,'2026-01-01')`);
    db.exec(`INSERT INTO task_attempts (attempt_id, task_id, adapter_id, adapter_kind, runner_id, status, started_at)
      VALUES ('attempt-1','task-1','script','script','runner-1','running','2026-01-01')`);

    const result = await runVerification(db, config, task, attempt);
    expect(result.outcome).toBe("passed");
    if (result.outcome === "passed") {
      expect(result.stdoutPath).toBeTruthy();
      const content = await Bun.file(result.stdoutPath!).text();
      expect(content).toContain("hello from verification");
    }

    const row = db.query("SELECT verification_stdout_path FROM task_attempts WHERE attempt_id = 'attempt-1'").get() as Record<string, unknown>;
    expect(row.verification_stdout_path).toBeTruthy();
  });
});

// hasShellComposition unit tests
describe("hasShellComposition", () => {
  test("detects &&", () => expect(hasShellComposition("echo a && echo b")).toBe(true));
  test("detects ;", () => expect(hasShellComposition("echo a; echo b")).toBe(true));
  test("detects |", () => expect(hasShellComposition("cat f | grep ok")).toBe(true));
  test("allows simple commands", () => expect(hasShellComposition("bun run scripts/verify.ts")).toBe(false));
  test("allows quoted semicolons", () => expect(hasShellComposition("echo 'a;b'")).toBe(false));
  test("allows quoted pipe", () => expect(hasShellComposition('echo "a|b"')).toBe(false));
});

// validateVerificationCmd unit tests
describe("validateVerificationCmd", () => {
  test("returns null for null", () => expect(validateVerificationCmd(null)).toBeNull());
  test("returns null for empty string", () => expect(validateVerificationCmd("")).toBeNull());
  test("returns error for &&", () => expect(validateVerificationCmd("a && b")).toMatch(/shell composition/));
  test("returns null for valid cmd", () => expect(validateVerificationCmd("bun run scripts/verify.ts")).toBeNull());
});

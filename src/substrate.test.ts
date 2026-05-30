// ---------------------------------------------------------------------------
// src/substrate.test.ts — Substrate intake adapter tests (Phase 5)
//
// Test strategy: mock at the postgres boundary via `mock.module` over
// @genesis-works/substrate-db. Decision: testcontainers require Docker which
// is not present on all slots. Mocking at the package boundary is sufficient
// for verifying the adapter's contract — log lines, write-back invocations,
// error containment, epoch threading, idempotency-key derivation.
//
// Coverage map:
//   resolveSubstrateConfig    — null branches + enabled-validated config
//   jobRowToTaskInput         — TaskInput mapping, idempotency_key, priority=1
//   createSubstrateConnection — explicit-host requirement
//   runSubstrateIntakeTick    — happy claim, null-claim (silent), db-unreachable,
//                               local-enqueue-fail
//   runSubstrateWriteBack     — non-substrate source no-op, missing job id no-op,
//                               complete happy, complete !ok (epoch-mismatch),
//                               complete throws (transient PG blip),
//                               fail happy, fail !ok
//   runSubstrateLeaseRecovery — released>0 logs, releaseExpiredLeases throws
// ---------------------------------------------------------------------------

import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "./db";
import type { RuntimeConfig, SubstrateConfig } from "./types";

// ---------------------------------------------------------------------------
// Mock @genesis-works/substrate-db at module-load boundary.
// Each test sets the desired return / throw on these mocks.
// ---------------------------------------------------------------------------

const mockClaimNextJob = mock();
const mockCompleteJob = mock();
const mockFailJob = mock();
const mockReleaseExpiredLeases = mock();
const mockCreateSubstrateClient = mock(() => ({ __mock: true }));

mock.module("@genesis-works/substrate-db", () => ({
  createSubstrateClient: mockCreateSubstrateClient,
  claimNextJob: mockClaimNextJob,
  completeJob: mockCompleteJob,
  failJob: mockFailJob,
  releaseExpiredLeases: mockReleaseExpiredLeases,
}));

// Import AFTER mock.module so the substrate module picks up the mock.
import {
  resolveSubstrateConfig,
  jobRowToTaskInput,
  createSubstrateConnection,
  runSubstrateIntakeTick,
  runSubstrateWriteBack,
  runSubstrateLeaseRecovery,
  type SubstrateDb,
} from "./substrate";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSubConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    enabled: true,
    credential: "substrate-pg-password",
    kinds: ["notch-task", "arc-task"],
    slotId: "192.168.1.12",
    leaseSecs: 300,
    host: "127.0.0.1",
    ...overrides,
  };
}

function makeRuntimeConfig(sub?: SubstrateConfig): RuntimeConfig {
  return {
    runtimeName: "test-runtime",
    runtimePolicy: "default",
    stateDir: "/tmp/test-state",
    logDir: "/tmp/test-logs",
    artifactDir: "/tmp/test-artifacts",
    dbPath: ":memory:",
    lockPath: "/tmp/test-dispatch.lock",
    defaultProfile: "default",
    defaultAdapter: "default",
    maxAttempts: 3,
    retryBackoffSeconds: 10,
    profiles: { default: "default" },
    adapters: {},
    substrate: sub,
  } as RuntimeConfig;
}

function makeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-abc-123",
    kind: "notch-task",
    payload: { subject: "Implement feature X" },
    status: "claimed" as const,
    claimed_by: "192.168.1.12",
    claimed_at: new Date(),
    lease_expires_at: new Date(),
    attempts: 1,
    claim_epoch: 1,
    max_attempts: 5,
    result: null,
    receipt: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeTaskRecord(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "t-local-1",
    source: "substrate:job-abc-123",
    payload: {
      _substrate_job_id: "job-abc-123",
      _substrate_claim_epoch: 1,
      idempotency_key: "substrate-job-abc-123-e1",
    },
    kind: "notch-task",
    subject: "Implement feature X",
    description: null,
    priority: 1,
    requested_profile: "default",
    requested_adapter: "default",
    status: "completed" as const,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    attempt_count: 1,
    max_attempts: 1,
    available_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    outcome: null,
    last_error: null,
    ...overrides,
  } as import("./types").TaskRecord;
}

const fakeDb = { __mock: true } as unknown as SubstrateDb;

let localDb: Database;
let consoleInfo: ReturnType<typeof spyOn>;
let consoleError: ReturnType<typeof spyOn>;
let consoleWarn: ReturnType<typeof spyOn>;

beforeEach(() => {
  mockClaimNextJob.mockReset();
  mockCompleteJob.mockReset();
  mockFailJob.mockReset();
  mockReleaseExpiredLeases.mockReset();
  // Use openDb so the full schema (tasks, run_events, task_attempts, etc.) is created.
  localDb = openDb(makeRuntimeConfig(makeSubConfig()));
  consoleInfo = spyOn(console, "info").mockImplementation(() => {});
  consoleError = spyOn(console, "error").mockImplementation(() => {});
  consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  consoleInfo.mockRestore();
  consoleError.mockRestore();
  consoleWarn.mockRestore();
  localDb.close();
});

// ---------------------------------------------------------------------------
// resolveSubstrateConfig
// ---------------------------------------------------------------------------

describe("resolveSubstrateConfig", () => {
  test("returns null when substrate not configured", () => {
    expect(resolveSubstrateConfig(makeRuntimeConfig())).toBeNull();
  });

  test("returns null when enabled is false", () => {
    expect(resolveSubstrateConfig(makeRuntimeConfig(makeSubConfig({ enabled: false })))).toBeNull();
  });

  test("returns null when credential is empty", () => {
    expect(resolveSubstrateConfig(makeRuntimeConfig(makeSubConfig({ credential: "" })))).toBeNull();
  });

  test("returns null when kinds is empty", () => {
    expect(resolveSubstrateConfig(makeRuntimeConfig(makeSubConfig({ kinds: [] })))).toBeNull();
  });

  test("returns null when slotId is empty", () => {
    expect(resolveSubstrateConfig(makeRuntimeConfig(makeSubConfig({ slotId: "" })))).toBeNull();
  });

  test("returns the substrate block when fully configured", () => {
    const sub = makeSubConfig();
    const result = resolveSubstrateConfig(makeRuntimeConfig(sub));
    expect(result).not.toBeNull();
    expect(result!.slotId).toBe("192.168.1.12");
    expect(result!.kinds).toEqual(["notch-task", "arc-task"]);
  });
});

// ---------------------------------------------------------------------------
// jobRowToTaskInput — payload threading, idempotency_key, priority
// ---------------------------------------------------------------------------

describe("jobRowToTaskInput", () => {
  test("threads _substrate_job_id, _substrate_claim_epoch, idempotency_key into payload", () => {
    const input = jobRowToTaskInput(makeJobRow({ id: "j-1", claim_epoch: 7 }));
    expect(input.payload._substrate_job_id).toBe("j-1");
    expect(input.payload._substrate_claim_epoch).toBe(7);
    expect(input.payload.idempotency_key).toBe("substrate-j-1-e7");
  });

  test("emits priority=1 so substrate tasks run on the same or next tick", () => {
    const input = jobRowToTaskInput(makeJobRow());
    expect(input.priority).toBe(1);
  });

  test("max_attempts=1 — substrate handles retry via releaseExpiredLeases", () => {
    const input = jobRowToTaskInput(makeJobRow());
    expect(input.max_attempts).toBe(1);
  });

  test("source ties back to the substrate job id", () => {
    const input = jobRowToTaskInput(makeJobRow({ id: "j-source-test" }));
    expect(input.source).toBe("substrate:j-source-test");
  });

  test("falls back to kind when no subject in payload", () => {
    const input = jobRowToTaskInput(makeJobRow({ payload: {}, kind: "arc-task" }));
    expect(input.subject).toBe("arc-task");
    expect(input.description).toBeUndefined();
  });

  test("propagates requested_profile / requested_adapter from payload", () => {
    const input = jobRowToTaskInput(
      makeJobRow({ payload: { requested_profile: "p", requested_adapter: "a" } })
    );
    expect(input.requested_profile).toBe("p");
    expect(input.requested_adapter).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// createSubstrateConnection — explicit-host requirement
// ---------------------------------------------------------------------------

describe("createSubstrateConnection", () => {
  test("throws when substrate.host is not set (no implicit default)", async () => {
    const sub = makeSubConfig({ host: undefined });
    await expect(createSubstrateConnection(sub)).rejects.toThrow(
      /substrate\.host is not set — explicit host required/
    );
  });

  test("throws when substrate.host is empty string", async () => {
    const sub = makeSubConfig({ host: "   " });
    await expect(createSubstrateConnection(sub)).rejects.toThrow(
      /substrate\.host is not set/
    );
  });
});

// ---------------------------------------------------------------------------
// runSubstrateIntakeTick — claim paths
// ---------------------------------------------------------------------------

describe("runSubstrateIntakeTick", () => {
  test("happy claim: enqueues local task and returns claimed=true with epoch", async () => {
    mockClaimNextJob.mockResolvedValueOnce(makeJobRow({ id: "j-happy", claim_epoch: 3 }));
    const result = await runSubstrateIntakeTick(
      fakeDb,
      makeSubConfig(),
      localDb,
      makeRuntimeConfig(makeSubConfig())
    );
    expect(result.claimed).toBe(true);
    if (result.claimed) {
      expect(result.jobId).toBe("j-happy");
      expect(result.epochUsed).toBe(3);
    }
    // Log line emitted on successful claim only.
    const claimLogged = consoleInfo.mock.calls.some(
      (args: unknown[]) => typeof args[0] === "string" && args[0].includes("[substrate] claim") && args[0].includes("result=j-happy")
    );
    expect(claimLogged).toBe(true);
  });

  test("null claim is silent (no [substrate] claim log emitted)", async () => {
    mockClaimNextJob.mockResolvedValueOnce(null);
    const result = await runSubstrateIntakeTick(
      fakeDb,
      makeSubConfig(),
      localDb,
      makeRuntimeConfig(makeSubConfig())
    );
    expect(result.claimed).toBe(false);
    const anyClaimLogged = consoleInfo.mock.calls.some(
      (args: unknown[]) => typeof args[0] === "string" && args[0].includes("[substrate] claim")
    );
    expect(anyClaimLogged).toBe(false);
  });

  test("db-unreachable: logs skip with distinct reason, does not throw", async () => {
    mockClaimNextJob.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await runSubstrateIntakeTick(
      fakeDb,
      makeSubConfig(),
      localDb,
      makeRuntimeConfig(makeSubConfig())
    );
    expect(result.claimed).toBe(false);
    if (!result.claimed) {
      expect(result.reason).toBe("db-unreachable");
    }
    const errored = consoleError.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("[substrate] skip") &&
        args[0].includes("reason=db-unreachable")
    );
    expect(errored).toBe(true);
  });

  test("local-enqueue-fail: enqueueTask throw is contained, logs distinct reason, substrate job stays under lease", async () => {
    mockClaimNextJob.mockResolvedValueOnce(makeJobRow({ id: "j-enqueue-fail" }));
    // Force enqueueTask to throw by closing the local db before the call.
    localDb.close();
    const result = await runSubstrateIntakeTick(
      fakeDb,
      makeSubConfig(),
      localDb,
      makeRuntimeConfig(makeSubConfig())
    );
    expect(result.claimed).toBe(false);
    if (!result.claimed) {
      expect(result.reason).toBe("local-enqueue-fail");
    }
    const errored = consoleError.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("[substrate] skip") &&
        args[0].includes("reason=local-enqueue-fail") &&
        args[0].includes("jobs.id=j-enqueue-fail")
    );
    expect(errored).toBe(true);
    // Re-open so afterEach's close is a no-op (idempotent close OK).
    localDb = openDb(makeRuntimeConfig(makeSubConfig()));
  });
});

// ---------------------------------------------------------------------------
// runSubstrateWriteBack — complete / fail / epoch-mismatch / transient throw
// ---------------------------------------------------------------------------

describe("runSubstrateWriteBack", () => {
  test("no-op for non-substrate task sources (does not touch substrate-db)", async () => {
    const task = makeTaskRecord({ source: "schedule:daily" });
    await runSubstrateWriteBack(fakeDb, task, {
      status: "completed",
      operator_summary: "done",
      machine_status: "ok" as const,
    });
    expect(mockCompleteJob).not.toHaveBeenCalled();
    expect(mockFailJob).not.toHaveBeenCalled();
  });

  test("no-op when payload is missing _substrate_job_id", async () => {
    const task = makeTaskRecord({ payload: { /* no _substrate_job_id */ } });
    await runSubstrateWriteBack(fakeDb, task, {
      status: "completed",
      operator_summary: "done",
      machine_status: "ok" as const,
    });
    expect(mockCompleteJob).not.toHaveBeenCalled();
  });

  test("complete happy path: calls completeJob with claim_epoch, logs success", async () => {
    mockCompleteJob.mockResolvedValueOnce({ ok: true });
    const task = makeTaskRecord();
    await runSubstrateWriteBack(fakeDb, task, {
      status: "completed",
      operator_summary: "ok",
      machine_status: "ok" as const,
      artifact_paths: ["/tmp/out.txt"],
    });
    expect(mockCompleteJob).toHaveBeenCalledTimes(1);
    const callArgs = mockCompleteJob.mock.calls[0];
    expect(callArgs[1]).toBe("job-abc-123");        // jobId
    expect(callArgs[3]).toBeUndefined();            // receipt (legacy positional)
    expect(callArgs[4]).toBe(1);                    // claim_epoch
    const success = consoleInfo.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("[substrate] complete") &&
        args[0].includes("jobs.id=job-abc-123") &&
        args[0].includes("epoch=1")
    );
    expect(success).toBe(true);
  });

  test("complete epoch-mismatch (!ok): emits self-contained fallback log [substrate] complete-failed", async () => {
    mockCompleteJob.mockResolvedValueOnce({ ok: false });
    const task = makeTaskRecord();
    await runSubstrateWriteBack(fakeDb, task, {
      status: "completed",
      operator_summary: "ok",
      machine_status: "ok" as const,
    });
    const fallback = consoleWarn.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("[substrate] complete-failed") &&
        args[0].includes("jobs.id=job-abc-123")
    );
    expect(fallback).toBe(true);
  });

  test("complete transient throw: catches, logs [substrate] write-back error, does not propagate", async () => {
    mockCompleteJob.mockRejectedValueOnce(new Error("connection reset"));
    const task = makeTaskRecord();
    await expect(
      runSubstrateWriteBack(fakeDb, task, {
        status: "completed",
        operator_summary: "ok",
        machine_status: "ok" as const,
      })
    ).resolves.toBeUndefined();
    const caught = consoleError.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("[substrate] write-back error=") &&
        args[0].includes("jobs.id=job-abc-123")
    );
    expect(caught).toBe(true);
  });

  test("fail happy path: calls failJob with claim_epoch, logs reason snippet", async () => {
    mockFailJob.mockResolvedValueOnce({ ok: true });
    const task = makeTaskRecord();
    await runSubstrateWriteBack(fakeDb, task, {
      status: "blocked",
      operator_summary: "blocked because X",
      machine_status: "blocked" as const,
    });
    expect(mockFailJob).toHaveBeenCalledTimes(1);
    const callArgs = mockFailJob.mock.calls[0];
    expect(callArgs[1]).toBe("job-abc-123");
    expect(callArgs[2]).toBe("blocked because X");
    expect(callArgs[3]).toBe(1);
    const failLogged = consoleInfo.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("[substrate] fail jobs.id=job-abc-123") &&
        args[0].includes("epoch=1") &&
        args[0].includes("reason=blocked because X")
    );
    expect(failLogged).toBe(true);
  });

  test("fail !ok: emits self-contained fallback log [substrate] fail-failed", async () => {
    mockFailJob.mockResolvedValueOnce({ ok: false });
    const task = makeTaskRecord();
    await runSubstrateWriteBack(fakeDb, task, {
      status: "blocked",
      operator_summary: "x",
      machine_status: "blocked" as const,
    });
    const fallback = consoleWarn.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("[substrate] fail-failed") &&
        args[0].includes("jobs.id=job-abc-123")
    );
    expect(fallback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runSubstrateLeaseRecovery
// ---------------------------------------------------------------------------

describe("runSubstrateLeaseRecovery", () => {
  test("released>0: logs lease-recovery released=<n>", async () => {
    mockReleaseExpiredLeases.mockResolvedValueOnce(3);
    await runSubstrateLeaseRecovery(fakeDb);
    const logged = consoleInfo.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" && args[0].includes("[substrate] lease-recovery released=3")
    );
    expect(logged).toBe(true);
  });

  test("released=0: no log emitted (quiet success)", async () => {
    mockReleaseExpiredLeases.mockResolvedValueOnce(0);
    await runSubstrateLeaseRecovery(fakeDb);
    const anyRecoveryLog = consoleInfo.mock.calls.some(
      (args: unknown[]) => typeof args[0] === "string" && args[0].includes("[substrate] lease-recovery")
    );
    expect(anyRecoveryLog).toBe(false);
  });

  test("releaseExpiredLeases throws: logs error, does not propagate", async () => {
    mockReleaseExpiredLeases.mockRejectedValueOnce(new Error("network blip"));
    await expect(runSubstrateLeaseRecovery(fakeDb)).resolves.toBeUndefined();
    const errored = consoleError.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" && args[0].includes("[substrate] lease-recovery error=")
    );
    expect(errored).toBe(true);
  });
});

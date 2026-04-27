import { existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { loadConfig } from "./config";
import {
  cancelTaskByOperator,
  enqueueTask,
  getAllWorkflows,
  getRecentRunEvents,
  getRecentTasks,
  getRunEventsSince,
  getStatusSummary,
  getTaskCountsByStatus,
  openDb,
  recordEvent
} from "./db";
import { readDispatchPause, writeDispatchPause } from "./pause";
import { createSnapshotReport, readSnapshot } from "./report";
import type { RunEventRecord, RuntimeConfig, RuntimeSnapshot, TaskRecord } from "./types";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf"
};

function parseArgs(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      continue;
    }
    const key = value.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache"
    }
  });
}

function notFound(message = "Not Found"): Response {
  return jsonResponse({ error: message }, 404);
}

function methodNotSupported(method: string): Response {
  return jsonResponse({ error: `${method} not supported` }, 405);
}

function normalizeWorkflow(workflow: ReturnType<typeof getAllWorkflows>[number]): Record<string, unknown> {
  return {
    ...workflow,
    context: workflow.context_json ? JSON.parse(workflow.context_json) as Record<string, unknown> : null
  };
}

function summarizeTask(task: TaskRecord): Record<string, unknown> {
  return {
    task_id: task.task_id,
    kind: task.kind,
    source: task.source,
    subject: task.subject,
    description: task.description,
    priority: task.priority,
    payload: task.payload,
    status: task.status,
    requested_profile: task.requested_profile,
    created_at: task.created_at,
    updated_at: task.updated_at,
    started_at: task.started_at,
    finished_at: task.finished_at,
    attempt_count: task.attempt_count,
    max_attempts: task.max_attempts,
    available_at: task.available_at,
    last_error: task.last_error,
    artifact_paths: task.outcome?.artifact_paths ?? [],
    operator_summary: task.outcome?.operator_summary ?? null,
    machine_status: task.outcome?.machine_status ?? null
  };
}

function readRuntimeStatus(db: Database): Record<string, unknown> {
  const summary = getStatusSummary(db);
  const counts = getTaskCountsByStatus(db);
  const runningState = counts.running > 0 ? "running" : "idle";
  return {
    runtime_state: runningState,
    counts: {
      queued: counts.pending + counts.retryable_failure,
      running: counts.running,
      completed: counts.completed,
      blocked: counts.blocked,
      retryable_failure: counts.retryable_failure,
      permanent_failure: counts.permanent_failure,
      operator_canceled: counts.operator_canceled
    },
    last_event: summary.lastEvent ?? null,
    recent: summary.recent ?? []
  };
}

function buildStatePayload(db: Database, config: RuntimeConfig): Record<string, unknown> {
  const status = readRuntimeStatus(db);
  const dispatchPaused = readDispatchPause(config);
  return {
    runtime_name: config.runtimeName,
    runtime_state: dispatchPaused.paused ? "paused" : status.runtime_state,
    counts: status.counts,
    dispatch_paused: dispatchPaused,
    last_event: status.last_event
  };
}

async function listArtifactEntries(rootDir: string, requestedPath = ""): Promise<Record<string, unknown>> {
  const safeRelative = requestedPath.replace(/^\/+/, "").replace(/\.\./g, "");
  const fullPath = path.join(rootDir, safeRelative);
  const rootResolved = path.resolve(rootDir);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(rootResolved)) {
    throw new Error("invalid artifact path");
  }

  let stats;
  try {
    stats = await stat(resolved);
  } catch {
    throw new Error("artifact path not found");
  }

  if (stats.isFile()) {
    return {
      path: safeRelative,
      type: "file"
    };
  }

  const entries = await readdir(resolved, { withFileTypes: true });
  const children = await Promise.all(entries.map(async (entry) => {
    const relativePath = path.join(safeRelative, entry.name).replace(/\\/g, "/");
    const childPath = path.join(resolved, entry.name);
    const childStats = await stat(childPath);
    return {
      name: entry.name,
      path: relativePath,
      type: entry.isDirectory() ? "directory" : "file",
      size: childStats.size,
      updated_at: childStats.mtime.toISOString()
    };
  }));

  return {
    path: safeRelative,
    type: "directory",
    entries: children.sort((a, b) => {
      if (a.type === b.type) {
        return String(a.name).localeCompare(String(b.name));
      }
      return a.type === "directory" ? -1 : 1;
    })
  };
}

async function readArtifactFile(rootDir: string, requestedPath: string): Promise<Record<string, unknown>> {
  const safeRelative = requestedPath.replace(/^\/+/, "").replace(/\.\./g, "");
  if (!safeRelative) {
    throw new Error("artifact file path required");
  }
  const fullPath = path.resolve(path.join(rootDir, safeRelative));
  if (!fullPath.startsWith(path.resolve(rootDir))) {
    throw new Error("invalid artifact path");
  }
  const stats = await stat(fullPath);
  if (!stats.isFile()) {
    throw new Error("artifact path is not a file");
  }

  const text = await Bun.file(fullPath).text();
  const extension = path.extname(fullPath).toLowerCase();
  return {
    path: safeRelative,
    size: stats.size,
    updated_at: stats.mtime.toISOString(),
    content_type: MIME_TYPES[extension] ?? "text/plain; charset=utf-8",
    content: text
  };
}

async function listSnapshots(config: RuntimeConfig): Promise<Array<Record<string, unknown>>> {
  const snapshotsDir = path.join(config.artifactDir, "snapshots");
  if (!existsSync(snapshotsDir)) {
    return [];
  }

  const entries = await readdir(snapshotsDir, { withFileTypes: true });
  const snapshots = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const snapshotPath = path.join(snapshotsDir, entry.name);
        const snapshot = await readSnapshot(snapshotPath);
        return {
          name: entry.name,
          path: snapshotPath,
          captured_at: snapshot.captured_at,
          runtime_name: snapshot.runtime_name,
          queued_tasks: snapshot.queued_tasks.length,
          completed_tasks: snapshot.status.counts.find((item) => item.status === "completed")?.count ?? 0
        };
      })
  );

  return snapshots.sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)));
}

function resolveSnapshotPath(config: RuntimeConfig, requestedPath: string): string {
  const snapshotsDir = path.resolve(path.join(config.artifactDir, "snapshots"));
  const resolved = path.resolve(requestedPath);
  if (!resolved.startsWith(snapshotsDir)) {
    throw new Error("invalid snapshot path");
  }
  return resolved;
}

async function queueOperatorTask(req: Request, db: Database, config: RuntimeConfig): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "valid JSON body is required" }, 400);
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return jsonResponse({ error: "message is required" }, 400);
  }

  const parentRef = typeof body.parent_id === "string" ? body.parent_id : null;
  const explicitSkillRefs = Array.isArray(body.skill_refs)
    ? body.skill_refs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const parsedSkillRefs = Array.from(message.matchAll(/(^|\s)\/([a-zA-Z][\w-]*)/g)).map((match) => match[2]);
  const skillRefs = [...new Set([...explicitSkillRefs, ...parsedSkillRefs].map((value) => value.trim()))];
  const subject = typeof body.subject === "string" && body.subject.trim()
    ? body.subject.trim()
    : message.slice(0, 120);
  const description = typeof body.description === "string" && body.description.trim()
    ? body.description.trim()
    : `Operator UI: ${message}`;

  const task = enqueueTask(db, config, {
    kind: "operator",
    source: "operator-ui",
    subject,
    description,
    priority: typeof body.priority === "number" ? body.priority : 5,
    payload: {
      message,
      ...(skillRefs.length > 0 ? { skill_refs: skillRefs } : {}),
      ...(parentRef ? { parent_id: parentRef } : {}),
      ...(typeof body.kind === "string" ? { kind_override: body.kind } : {})
    },
    requested_profile: typeof body.requested_profile === "string" ? body.requested_profile : config.defaultProfile,
    requested_adapter: typeof body.requested_adapter === "string" ? body.requested_adapter : config.defaultAdapter,
    max_attempts: typeof body.max_attempts === "number" ? body.max_attempts : config.maxAttempts
  });

  return jsonResponse({ ok: true, task_id: task.task_id, kind: task.kind, source: task.source }, 201);
}

async function setPauseState(req: Request, db: Database, config: RuntimeConfig): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "valid JSON body is required" }, 400);
  }
  if (typeof body.paused !== "boolean") {
    return jsonResponse({ error: "paused boolean is required" }, 400);
  }
  const reason = typeof body.reason === "string" ? body.reason : null;
  const state = writeDispatchPause(config, body.paused, reason);
  recordPauseEvent(db, state.paused, state.reason);
  return jsonResponse({ ok: true, ...state });
}

function recordPauseEvent(db: Database, paused: boolean, reason: string | null): void {
  const eventType = paused ? "dispatch_pause_enabled" : "dispatch_pause_cleared";
  recordEvent(db, eventType, null, { reason });
}

function serializeSse(event: string, data: unknown): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readAdjacentSnapshotReport(config: RuntimeConfig): Promise<Record<string, unknown> | null> {
  const snapshots = await listSnapshots(config);
  if (snapshots.length < 2) {
    return null;
  }
  const afterPath = String(snapshots[0].path);
  const beforePath = String(snapshots[1].path);
  return createSnapshotReport(beforePath, afterPath);
}

async function serveStaticFile(filePath: string): Promise<Response | null> {
  const staticDir = path.resolve(path.join(import.meta.dir, "web"));
  const safePath = filePath === "/" ? "index.html" : filePath.replace(/^\/+/, "");
  const fullPath = path.resolve(path.join(staticDir, safePath));
  if (!fullPath.startsWith(staticDir) || !existsSync(fullPath)) {
    return null;
  }
  const extension = path.extname(fullPath);
  return new Response(readFileSync(fullPath), {
    headers: {
      "Content-Type": MIME_TYPES[extension] ?? "application/octet-stream",
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=300"
    }
  });
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const configPath = typeof flags.config === "string" ? flags.config : undefined;
  const host = typeof flags.host === "string" ? flags.host : "0.0.0.0";
  const port = typeof flags.port === "string" ? Number(flags.port) : 4314;
  const { config } = await loadConfig(configPath);
  const db = openDb(config);

  const server = Bun.serve({
    hostname: host,
    port,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/api/state") {
        return jsonResponse(buildStatePayload(db, config));
      }

      if (url.pathname === "/api/heartbeat") {
        return jsonResponse({ ok: true, latency_ms: 0 });
      }

      if (url.pathname === "/api/pause") {
        if (req.method === "GET") {
          return jsonResponse(readDispatchPause(config));
        }
        if (req.method === "POST") {
          return setPauseState(req, db, config);
        }
        return methodNotSupported(req.method);
      }

      if (url.pathname === "/api/workflows") {
        return jsonResponse({ workflows: getAllWorkflows(db).map(normalizeWorkflow) });
      }

      if (url.pathname === "/api/tasks/queue") {
        if (req.method !== "POST") {
          return methodNotSupported(req.method);
        }
        return queueOperatorTask(req, db, config);
      }

      const cancelMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
      if (cancelMatch) {
        if (req.method !== "POST") {
          return methodNotSupported(req.method);
        }
        let reason: string | null = null;
        try {
          const body = await req.json() as Record<string, unknown>;
          reason = typeof body.reason === "string" ? body.reason : null;
        } catch {
          reason = null;
        }
        try {
          const task = cancelTaskByOperator(db, cancelMatch[1], reason);
          return jsonResponse({ ok: true, task_id: task.task_id, status: task.status });
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : "cancel failed" }, 400);
        }
      }

      if (url.pathname === "/api/tasks") {
        if (req.method !== "GET") {
          return methodNotSupported(req.method);
        }
        const limit = Number(url.searchParams.get("limit") || "20");
        const status = url.searchParams.get("status");
        const statuses = status ? [status as TaskRecord["status"]] : undefined;
        return jsonResponse({ tasks: getRecentTasks(db, limit, statuses).map(summarizeTask) });
      }

      if (url.pathname === "/api/events") {
        if (req.method !== "GET") {
          return methodNotSupported(req.method);
        }
        const since = Number(url.searchParams.get("since") || "0");
        const limit = Number(url.searchParams.get("limit") || "50");
        const events = since > 0 ? getRunEventsSince(db, since, limit) : getRecentRunEvents(db, limit);
        return jsonResponse({ events });
      }

      if (url.pathname === "/api/artifacts") {
        try {
          return jsonResponse(await listArtifactEntries(config.artifactDir, url.searchParams.get("path") || ""));
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : "artifact read failed" }, 400);
        }
      }

      if (url.pathname === "/api/artifact") {
        try {
          return jsonResponse(await readArtifactFile(config.artifactDir, url.searchParams.get("path") || ""));
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : "artifact read failed" }, 400);
        }
      }

      if (url.pathname === "/api/snapshots") {
        return jsonResponse({ snapshots: await listSnapshots(config) });
      }

      if (url.pathname === "/artifacts") {
        try {
          return jsonResponse(await listArtifactEntries(config.artifactDir, url.searchParams.get("path") || ""));
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : "artifact read failed" }, 400);
        }
      }

      if (url.pathname === "/snapshots") {
        return jsonResponse({ snapshots: await listSnapshots(config) });
      }

      if (url.pathname === "/api/snapshot") {
        const snapshotPath = url.searchParams.get("path");
        if (!snapshotPath) {
          return jsonResponse({ error: "snapshot path required" }, 400);
        }
        try {
          const snapshot = await readSnapshot(resolveSnapshotPath(config, snapshotPath));
          return jsonResponse(snapshot);
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : "snapshot read failed" }, 400);
        }
      }

      if (url.pathname === "/api/report") {
        const before = url.searchParams.get("before");
        const after = url.searchParams.get("after");
        if (!before || !after) {
          return jsonResponse({ error: "before and after snapshot paths are required" }, 400);
        }
        try {
          return jsonResponse(await createSnapshotReport(
            resolveSnapshotPath(config, before),
            resolveSnapshotPath(config, after)
          ));
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : "report read failed" }, 400);
        }
      }

      if (url.pathname === "/api/report/latest") {
        const report = await readAdjacentSnapshotReport(config);
        return jsonResponse({ report });
      }

      if (url.pathname === "/api/stream") {
        let lastSeenId = Number(url.searchParams.get("since") || "0");
        let intervalId: ReturnType<typeof setInterval> | null = null;
        let closed = false;

        const stream = new ReadableStream({
          async start(controller) {
            const initial = {
              ...buildStatePayload(db, config),
              runtime_policy: config.runtimePolicy
            };
            const recentEvents = getRecentRunEvents(db, 1);
            if (recentEvents.length > 0) {
              lastSeenId = recentEvents[0].id;
            }
            controller.enqueue(serializeSse("dashboard", initial));

            intervalId = setInterval(async () => {
              if (closed) {
                return;
              }
              const events = getRunEventsSince(db, lastSeenId, 50);
              if (events.length === 0) {
                return;
              }
              lastSeenId = events[events.length - 1].id;
              const status = readRuntimeStatus(db);
              controller.enqueue(serializeSse("events", {
                events,
                status,
                state: buildStatePayload(db, config)
              }));
            }, 3000);

            req.signal.addEventListener("abort", () => {
              closed = true;
              if (intervalId) {
                clearInterval(intervalId);
              }
              controller.close();
            });
          }
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          }
        });
      }

      if (url.pathname.startsWith("/fonts/")) {
        const fontPath = url.pathname.replace(/^\/fonts\//, "");
        const publicFontsDir = path.resolve(path.join(import.meta.dir, "..", "public", "fonts"));
        const fullPath = path.resolve(path.join(publicFontsDir, fontPath));
        if (!fullPath.startsWith(publicFontsDir) || !existsSync(fullPath)) {
          return notFound();
        }
        const extension = path.extname(fullPath);
        return new Response(readFileSync(fullPath), {
          headers: {
            "Content-Type": MIME_TYPES[extension] ?? "application/octet-stream",
            "Cache-Control": "public, max-age=86400"
          }
        });
      }

      if (url.pathname === "/favicon.ico") {
        return new Response(null, { status: 204, headers: { "Cache-Control": "public, max-age=86400" } });
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return (await serveStaticFile("/index.html")) ?? notFound();
      }

      const staticResponse = await serveStaticFile(url.pathname);
      return staticResponse ?? notFound();
    }
  });

  process.on("SIGINT", () => {
    db.close(false);
    server.stop(true);
    process.exit(0);
  });

  console.log(JSON.stringify({ ok: true, host, port: server.port, runtime: config.runtimeName }, null, 2));
  await new Promise<void>(() => {
    // Keep the process resident when launched by systemd or other non-interactive supervisors.
  });
}

void main();

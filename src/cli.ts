import { loadConfig } from "./config";
import {
  completeWorkflow,
  enqueueTask,
  getAllActiveWorkflows,
  getStatusSummary,
  getWorkflowById,
  getWorkflowByInstanceKey,
  insertWorkflow,
  openDb,
  updateWorkflowState
} from "./db";
import { runOnce } from "./runtime";
import { githubEventToTask } from "./bridges/github";
import { discordEventToTask } from "./bridges/discord";
import { healthcheckAdapter } from "./adapters";
import { loadProfile } from "./profiles";
import { validateProfile, validateRuntimeConfig } from "./validation";
import { getAllowedTransitions, getTemplateByName } from "./workflows";
import type { TaskInput } from "./types";
import { writeSnapshot } from "./snapshot";
import { createSnapshotReport } from "./report";
import { processSensorEvent } from "./sensors";
import { enqueueDueSchedules, upsertRecurringSchedule } from "./schedules";

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

function readTaskInput(flags: Record<string, string | boolean>): Promise<TaskInput> {
  if (typeof flags.json === "string") {
    return Promise.resolve(JSON.parse(flags.json) as TaskInput);
  }
  if (typeof flags.file === "string") {
    return Bun.file(flags.file).json() as Promise<TaskInput>;
  }
  throw new Error("Provide --json '<task>' or --file path/to/task.json");
}

async function readJsonFile(flags: Record<string, string | boolean>): Promise<unknown> {
  if (typeof flags.file !== "string") {
    throw new Error("Provide --file path/to/event.json");
  }
  return Bun.file(flags.file).json();
}

async function seedBacklog(
  flags: Record<string, string | boolean>,
  config: Awaited<ReturnType<typeof loadConfig>>["config"],
  db: ReturnType<typeof openDb>
): Promise<Record<string, unknown>> {
  if (typeof flags.file !== "string") {
    throw new Error("Provide --file path/to/backlog.json");
  }
  const backlog = await Bun.file(flags.file).json() as {
    workflows?: Array<{ template: string; instance_key: string; state?: string; context?: Record<string, unknown> }>;
    tasks?: TaskInput[];
  };

  const createdWorkflows: Array<Record<string, unknown>> = [];
  const queuedTasks: Array<Record<string, unknown>> = [];

  for (const workflow of backlog.workflows ?? []) {
    const template = getTemplateByName(workflow.template);
    if (!template) {
      continue;
    }
    const existing = getWorkflowByInstanceKey(db, workflow.instance_key);
    if (existing) {
      createdWorkflows.push({ created: false, workflow });
      continue;
    }
    const id = insertWorkflow(db, {
      template: workflow.template,
      instance_key: workflow.instance_key,
      current_state: workflow.state ?? template.initialState,
      context_json: workflow.context ? JSON.stringify(workflow.context) : null
    });
    createdWorkflows.push({ created: true, workflow_id: id, workflow });
  }

  for (const taskInput of backlog.tasks ?? []) {
    const task = enqueueTask(db, config, taskInput);
    queuedTasks.push({ task_id: task.task_id, kind: task.kind, source: task.source });
  }

  return { createdWorkflows, queuedTasks };
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const flags = parseArgs(rest);
  const configPath = typeof flags.config === "string" ? flags.config : undefined;
  const { config } = await loadConfig(configPath);
  const db = openDb(config);
  try {
    switch (command) {
      case "intake": {
        const taskInput = await readTaskInput(flags);
        const task = enqueueTask(db, config, taskInput);
        console.log(JSON.stringify({ queued: true, task_id: task.task_id, profile: task.requested_profile, available_at: task.available_at }, null, 2));
        break;
      }
      case "schedule-create": {
        const input = typeof flags.json === "string"
          ? JSON.parse(flags.json)
          : typeof flags.file === "string"
            ? await Bun.file(flags.file).json()
            : null;
        if (!input) {
          throw new Error("Provide --json '<schedule>' or --file path/to/schedule.json");
        }
        const schedule = upsertRecurringSchedule(db, input);
        console.log(JSON.stringify({ upserted: true, schedule }, null, 2));
        break;
      }
      case "schedule-tick": {
        const at = typeof flags.at === "string" ? new Date(flags.at).toISOString() : undefined;
        const result = enqueueDueSchedules(db, config, at);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "sensor-event": {
        const input = typeof flags.json === "string"
          ? JSON.parse(flags.json)
          : typeof flags.file === "string"
            ? await Bun.file(flags.file).json()
            : null;
        if (!input) {
          throw new Error("Provide --json '<sensor-event>' or --file path/to/sensor-event.json");
        }
        const result = processSensorEvent(db, config, input);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "run-once": {
        const result = await runOnce(db, config);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "status": {
        const summary = getStatusSummary(db);
        console.log(JSON.stringify(summary, null, 2));
        break;
      }
      case "bridge-github": {
        const event = await readJsonFile(flags);
        const task = enqueueTask(db, config, githubEventToTask(event as never));
        console.log(JSON.stringify({ queued: true, bridge: "github", task_id: task.task_id, profile: task.requested_profile }, null, 2));
        break;
      }
      case "bridge-discord": {
        const event = await readJsonFile(flags);
        const task = enqueueTask(db, config, discordEventToTask(event as never));
        console.log(JSON.stringify({ queued: true, bridge: "discord", task_id: task.task_id, profile: task.requested_profile }, null, 2));
        break;
      }
      case "adapters": {
        const checks = await Promise.all(
          Object.keys(config.adapters).map((adapterId) => healthcheckAdapter(adapterId, config))
        );
        const adapters = checks.map((check) => {
          const adapter = config.adapters[check.adapterId];
          const isDefault = check.adapterId === config.defaultAdapter;
          const adapterCommand = "command" in adapter ? adapter.command : null;
          const fallback = "fallback_adapter" in adapter ? adapter.fallback_adapter : undefined;
          const brokenReason = !check.ok
            ? (typeof check.detail.error === "string"
              ? check.detail.error
              : check.detail.command_path === null
                ? `command not found: ${check.detail.command ?? adapterCommand}`
                : "healthcheck failed")
            : undefined;
          return {
            id: check.adapterId,
            mode: adapter.mode,
            isDefault,
            ok: check.ok,
            ...(fallback ? { fallback_adapter: fallback } : {}),
            ...(brokenReason ? { broken_reason: brokenReason } : {}),
            detail: check.detail
          };
        });
        const defaultEntry = adapters.find((a) => a.isDefault);
        const defaultOk = defaultEntry?.ok ?? false;
        const result: Record<string, unknown> = {
          defaultAdapter: config.defaultAdapter,
          defaultOk,
          adapters
        };
        if (flags.probe) {
          const { selectAdapterWithFallback, clearAdapterProbeCache } = await import("./adapter-probe");
          clearAdapterProbeCache();
          const selection = await selectAdapterWithFallback(config, config.defaultAdapter);
          result.probe = {
            requested_adapter: config.defaultAdapter,
            selected_adapter: selection.adapterId,
            chain: selection.chain
          };
        }
        console.log(JSON.stringify(result, null, 2));
        if (!defaultOk) {
          process.exitCode = 1;
        }
        break;
      }
      case "healthcheck": {
        const configIssues = await validateRuntimeConfig(config);
        const profileChecks = await Promise.all(
          Object.keys(config.profiles).map(async (profileId) => {
            const profile = await loadProfile(config, profileId);
            return {
              profileId,
              issues: validateProfile(profile)
            };
          })
        );
        const adapterChecks = await Promise.all(
          Object.keys(config.adapters).map((adapterId) => healthcheckAdapter(adapterId, config))
        );
        const ok =
          configIssues.length === 0 &&
          profileChecks.every((profile) => profile.issues.length === 0) &&
          adapterChecks.every((adapter) => adapter.ok);
        console.log(JSON.stringify({ ok, configIssues, profileChecks, adapterChecks }, null, 2));
        if (!ok) {
          process.exitCode = 1;
        }
        break;
      }
      case "workflow-list": {
        console.log(JSON.stringify({ workflows: getAllActiveWorkflows(db) }, null, 2));
        break;
      }
      case "workflow-show": {
        const workflow = typeof flags.id === "string"
          ? getWorkflowById(db, Number(flags.id))
          : typeof flags.instance_key === "string"
            ? getWorkflowByInstanceKey(db, flags.instance_key)
            : null;
        if (!workflow) {
          throw new Error("Provide --id <number> or --instance_key <key> for an existing workflow");
        }
        console.log(JSON.stringify({
          ...workflow,
          context: workflow.context_json ? JSON.parse(workflow.context_json) : null
        }, null, 2));
        break;
      }
      case "workflow-create": {
        if (typeof flags.template !== "string" || typeof flags.instance_key !== "string") {
          throw new Error("Provide --template <name> and --instance_key <key>");
        }
        const template = getTemplateByName(flags.template);
        if (!template) {
          throw new Error(`Unknown workflow template: ${flags.template}`);
        }
        const existing = getWorkflowByInstanceKey(db, flags.instance_key);
        if (existing) {
          console.log(JSON.stringify({ created: false, workflow: existing }, null, 2));
          break;
        }
        const contextJson = typeof flags.context === "string" ? flags.context : null;
        if (contextJson) {
          JSON.parse(contextJson);
        }
        const state = typeof flags.state === "string" ? flags.state : template.initialState;
        const id = insertWorkflow(db, {
          template: flags.template,
          instance_key: flags.instance_key,
          current_state: state,
          context_json: contextJson
        });
        console.log(JSON.stringify({ created: true, workflow_id: id, template: flags.template, instance_key: flags.instance_key, state }, null, 2));
        break;
      }
      case "workflow-transition": {
        if (typeof flags.id !== "string" || typeof flags.state !== "string") {
          throw new Error("Provide --id <number> and --state <new_state>");
        }
        const workflow = getWorkflowById(db, Number(flags.id));
        if (!workflow) {
          throw new Error(`Workflow not found: ${flags.id}`);
        }
        const template = getTemplateByName(workflow.template);
        if (!template) {
          throw new Error(`Unknown workflow template: ${workflow.template}`);
        }
        const allowed = getAllowedTransitions(workflow.current_state, template);
        if (!Object.values(allowed).includes(flags.state)) {
          throw new Error(`Transition not allowed from ${workflow.current_state} to ${flags.state}`);
        }
        const incoming = typeof flags.context === "string" ? JSON.parse(flags.context) as Record<string, unknown> : {};
        const existingContext = workflow.context_json ? JSON.parse(workflow.context_json) as Record<string, unknown> : {};
        updateWorkflowState(db, workflow.id, flags.state, JSON.stringify({ ...existingContext, ...incoming }));
        console.log(JSON.stringify({ transitioned: true, workflow_id: workflow.id, from: workflow.current_state, to: flags.state }, null, 2));
        break;
      }
      case "workflow-complete": {
        if (typeof flags.id !== "string") {
          throw new Error("Provide --id <number>");
        }
        completeWorkflow(db, Number(flags.id));
        console.log(JSON.stringify({ completed: true, workflow_id: Number(flags.id) }, null, 2));
        break;
      }
      case "snapshot": {
        const label = typeof flags.label === "string" ? flags.label : undefined;
        const result = await writeSnapshot(db, config, label);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "seed-backlog": {
        const result = await seedBacklog(flags, config, db);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "report": {
        if (typeof flags.before !== "string" || typeof flags.after !== "string") {
          throw new Error("Provide --before path/to/snapshot.json and --after path/to/snapshot.json");
        }
        const result = await createSnapshotReport(flags.before, flags.after);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      default: {
        console.error("Usage: bun run src/cli.ts <intake|schedule-create|schedule-tick|sensor-event|run-once|status|adapters|bridge-github|bridge-discord|healthcheck|workflow-list|workflow-show|workflow-create|workflow-transition|workflow-complete|snapshot|seed-backlog|report> [--config path] [--json json | --file path]");
        process.exitCode = 1;
      }
    }
  } finally {
    db.close(false);
  }
}

void main();
